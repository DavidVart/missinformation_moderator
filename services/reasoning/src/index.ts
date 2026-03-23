import {
  CONSUMER_GROUPS,
  STREAM_NAMES,
  baseServiceEnvSchema,
  createEnv,
  createJsonConsumer,
  createRedisConnection,
  xAddJson
} from "@project-veritas/config";
import {
  claimAssessmentSchema,
  parseStreamPayload,
  transcriptSegmentSchema
} from "@project-veritas/contracts";
import { createHttpLogger, createLogger } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import {
  buildRollingWindow,
  buildWindowSignature,
  claimIdentityKey,
  claimsAreEquivalent,
  createReasoningEngine,
  fetchCitations,
  shouldAssessWindow
} from "./reasoning-engine.js";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4002),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  TAVILY_API_KEY: z.string().optional()
});

const logger = createLogger("reasoning-service", env.LOG_LEVEL);
const app = express();
const transcriptWindowTtlSeconds = 60 * 10;
const dedupeTtlSeconds = 60 * 5;
const reasoningEngine = createReasoningEngine({
  openAiApiKey: env.OPENAI_API_KEY,
  openAiModel: env.OPENAI_MODEL,
  tavilyApiKey: env.TAVILY_API_KEY
});

app.use(cors());
app.use(createHttpLogger("reasoning-service", env.LOG_LEVEL));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "reasoning"
  });
});

function windowKey(sessionId: string) {
  return `session:${sessionId}:window`;
}

function dedupeKey(sessionId: string, claimText: string) {
  return `session:${sessionId}:claim:${claimIdentityKey(claimText)}`;
}

async function bootstrap() {
  const redis = await createRedisConnection(env.REDIS_URL);
  const detectionConsumer = await createRedisConnection(env.REDIS_URL);
  const verificationConsumer = await createRedisConnection(env.REDIS_URL);
  const lastAssessedSignature = new Map<string, string>();
  const recentClaimsBySession = new Map<string, Array<{ claimText: string; checkedAtMs: number }>>();

  function rememberClaim(sessionId: string, claimText: string) {
    const now = Date.now();
    const nextClaims = [...(recentClaimsBySession.get(sessionId) ?? []), { claimText, checkedAtMs: now }]
      .filter((entry) => now - entry.checkedAtMs <= dedupeTtlSeconds * 1000)
      .slice(-12);

    recentClaimsBySession.set(sessionId, nextClaims);
  }

  function hasEquivalentRecentClaim(sessionId: string, claimText: string) {
    const now = Date.now();
    const recentClaims = (recentClaimsBySession.get(sessionId) ?? [])
      .filter((entry) => now - entry.checkedAtMs <= dedupeTtlSeconds * 1000);

    recentClaimsBySession.set(sessionId, recentClaims);
    return recentClaims.some((entry) => claimsAreEquivalent(entry.claimText, claimText));
  }

  void createJsonConsumer(
    detectionConsumer,
    STREAM_NAMES.transcriptSegments,
    CONSUMER_GROUPS.reasoning,
    `reasoning-${uuidv4()}`,
    (value) => parseStreamPayload(value, transcriptSegmentSchema),
    async (_id, segment) => {
      const key = windowKey(segment.sessionId);
      await redis.rPush(key, JSON.stringify(segment));
      await redis.lTrim(key, -3, -1);
      await redis.expire(key, transcriptWindowTtlSeconds);

      const rawSegments = await redis.lRange(key, 0, -1);
      const segments = rawSegments.map((rawSegment) => transcriptSegmentSchema.parse(JSON.parse(rawSegment)));
      const rollingWindow = buildRollingWindow(segments);
      const windowSignature = buildWindowSignature(rollingWindow);

      if (!shouldAssessWindow(rollingWindow, lastAssessedSignature.get(segment.sessionId))) {
        return;
      }

      lastAssessedSignature.set(segment.sessionId, windowSignature);
      const assessmentStartedAtMs = Date.now();
      const assessment = await reasoningEngine.assessWindow(segment.sessionId, rollingWindow);
      const assessmentDurationMs = Date.now() - assessmentStartedAtMs;

      if (!assessment) {
        return;
      }

      const claimSeen = await redis.get(dedupeKey(segment.sessionId, assessment.claimText));
      if (claimSeen || hasEquivalentRecentClaim(segment.sessionId, assessment.claimText)) {
        logger.info({
          sessionId: segment.sessionId,
          seq: segment.seq,
          claimText: assessment.claimText,
          assessmentDurationMs
        }, "Skipped duplicate claim assessment");
        return;
      }

      await redis.set(dedupeKey(segment.sessionId, assessment.claimText), "1", {
        EX: dedupeTtlSeconds
      });
      rememberClaim(segment.sessionId, assessment.claimText);

      logger.info({
        sessionId: segment.sessionId,
        seq: segment.seq,
        claimText: assessment.claimText,
        assessmentDurationMs,
        detectionLagMs: Math.max(0, Date.now() - Date.parse(segment.endedAt))
      }, "Detected claim candidate");
      await xAddJson(redis, STREAM_NAMES.claimsDetected, assessment);
    }
  );

  void createJsonConsumer(
    verificationConsumer,
    STREAM_NAMES.claimsDetected,
    CONSUMER_GROUPS.reasoning,
    `reasoning-verifier-${uuidv4()}`,
    (value) => parseStreamPayload(value, claimAssessmentSchema),
    async (_id, assessment) => {
      const verificationStartedAtMs = Date.now();
      const citations = await fetchCitations(assessment.query, env.TAVILY_API_KEY);
      const verification = await reasoningEngine.verifyClaim(assessment, citations);
      await xAddJson(redis, STREAM_NAMES.verdictsCompleted, verification);
      logger.info({
        sessionId: assessment.sessionId,
        claimText: assessment.claimText,
        verdict: verification.verdict,
        confidence: verification.confidence,
        verificationDurationMs: Date.now() - verificationStartedAtMs
      }, "Completed claim verification");
    }
  );

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Reasoning service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Reasoning service failed to start");
  process.exit(1);
});
