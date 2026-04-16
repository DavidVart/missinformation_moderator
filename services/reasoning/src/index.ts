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
  claimVerificationResultSchema,
  parseStreamPayload,
  transcriptSegmentSchema,
  type SourceCitation
} from "@project-veritas/contracts";
import { Sentry, createHttpLogger, createLogger, initSentry } from "@project-veritas/observability";
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
import { createInterventionMessage, shouldPublishNotification } from "./notification.js";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4002),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  TAVILY_API_KEY: z.string().optional(),
  INTERVENTION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75)
});

initSentry("reasoning-service");

const logger = createLogger("reasoning-service", env.LOG_LEVEL);
const app = express();
const transcriptWindowTtlSeconds = 60 * 10;
const dedupeTtlSeconds = 60 * 5;

const isRealMode = !!env.OPENAI_API_KEY && !!env.TAVILY_API_KEY;
if (isRealMode) {
  logger.info("Reasoning engine: REAL mode (OpenAI + Tavily)");
} else {
  logger.warn({
    hasOpenAiKey: !!env.OPENAI_API_KEY,
    hasTavilyKey: !!env.TAVILY_API_KEY
  }, "Reasoning engine: MOCK mode — API keys missing, fact-checking disabled");
  Sentry.captureMessage("Reasoning service started in MOCK mode — API keys missing", "warning");
}

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
    service: "reasoning",
    mode: isRealMode ? "real" : "mock",
    confidenceThreshold: env.INTERVENTION_CONFIDENCE_THRESHOLD
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
  const notificationConsumer = await createRedisConnection(env.REDIS_URL);
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
      // Pipeline: push + trim + expire + read in fewer round-trips
      await redis.rPush(key, JSON.stringify(segment));
      await redis.lTrim(key, -3, -1);
      const [rawSegments] = await Promise.all([
        redis.lRange(key, 0, -1),
        redis.expire(key, transcriptWindowTtlSeconds)
      ]);
      const segments = rawSegments.map((rawSegment) => transcriptSegmentSchema.parse(JSON.parse(rawSegment)));
      const rollingWindow = buildRollingWindow(segments);
      const windowSignature = buildWindowSignature(rollingWindow);

      if (!shouldAssessWindow(rollingWindow, lastAssessedSignature.get(segment.sessionId))) {
        return;
      }

      lastAssessedSignature.set(segment.sessionId, windowSignature);
      const assessmentStartedAtMs = Date.now();

      let assessment;
      try {
        assessment = await reasoningEngine.assessWindow(segment.sessionId, rollingWindow);
      } catch (error) {
        logger.error({ err: error, sessionId: segment.sessionId, seq: segment.seq }, "Claim detection failed");
        Sentry.captureException(error, {
          tags: { phase: "detection", sessionId: segment.sessionId },
          extra: { windowSignature, segmentText: segment.text }
        });
        return;
      }

      const assessmentDurationMs = Date.now() - assessmentStartedAtMs;

      if (!assessment) {
        logger.debug({ sessionId: segment.sessionId, seq: segment.seq, assessmentDurationMs }, "No verifiable claim in window");
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

      let citations: SourceCitation[];
      try {
        citations = await fetchCitations(assessment.query, env.TAVILY_API_KEY);
      } catch (error) {
        logger.error({ err: error, claimText: assessment.claimText }, "Tavily citation fetch failed");
        Sentry.captureException(error, {
          tags: { phase: "citation", sessionId: assessment.sessionId },
          extra: { query: assessment.query, claimText: assessment.claimText }
        });
        citations = [];
      }

      let verification;
      try {
        verification = await reasoningEngine.verifyClaim(assessment, citations);
      } catch (error) {
        logger.error({ err: error, claimText: assessment.claimText }, "Claim verification failed");
        Sentry.captureException(error, {
          tags: { phase: "verification", sessionId: assessment.sessionId },
          extra: { claimText: assessment.claimText, citationCount: citations.length }
        });
        return;
      }

      await xAddJson(redis, STREAM_NAMES.verdictsCompleted, verification);
      logger.info({
        sessionId: assessment.sessionId,
        claimText: assessment.claimText,
        verdict: verification.verdict,
        confidence: verification.confidence,
        citationCount: citations.length,
        verificationDurationMs: Date.now() - verificationStartedAtMs
      }, "Completed claim verification");
    }
  );

  // V2: rate-limit interventions to max 1 per 15 seconds per session so the
  // user isn't overwhelmed by rapid-fire corrections on dense debate audio.
  const INTERVENTION_RATE_LIMIT_MS = 15_000;
  const lastInterventionAtMs = new Map<string, number>();

  // ── Notification consumer (from notification service) ──
  void createJsonConsumer(
    notificationConsumer,
    STREAM_NAMES.verdictsCompleted,
    CONSUMER_GROUPS.notification,
    `notification-${uuidv4()}`,
    (value) => parseStreamPayload(value, claimVerificationResultSchema),
    async (_id, result) => {
      logger.info({
        sessionId: result.sessionId,
        claimText: result.claimText,
        verdict: result.verdict,
        confidence: result.confidence,
        mode: result.mode,
        speakerRole: result.speakerRole
      }, "Received verdict for notification");

      if (!shouldPublishNotification(result, env.INTERVENTION_CONFIDENCE_THRESHOLD)) {
        logger.info({
          sessionId: result.sessionId,
          verdict: result.verdict,
          confidence: result.confidence,
          speakerRole: result.speakerRole,
          threshold: env.INTERVENTION_CONFIDENCE_THRESHOLD
        }, "Verdict did not meet intervention criteria");
        return;
      }

      // V2: rate-limit check
      const now = Date.now();
      const lastAt = lastInterventionAtMs.get(result.sessionId) ?? 0;
      if (now - lastAt < INTERVENTION_RATE_LIMIT_MS) {
        logger.info({
          sessionId: result.sessionId,
          msSinceLast: now - lastAt,
          rateLimitMs: INTERVENTION_RATE_LIMIT_MS
        }, "Intervention rate-limited — dropped");
        return;
      }

      try {
        const message = createInterventionMessage(result);
        await xAddJson(redis, STREAM_NAMES.notificationsOutbound, message);
        lastInterventionAtMs.set(result.sessionId, now);
        logger.info({
          sessionId: result.sessionId,
          claimText: result.claimText,
          verdict: result.verdict,
          attributedTo: message.attributedTo
        }, "Published intervention notification");
      } catch (error) {
        logger.error({ err: error, sessionId: result.sessionId }, "Failed to publish intervention");
        Sentry.captureException(error, {
          tags: { sessionId: result.sessionId },
          extra: { claimText: result.claimText, verdict: result.verdict }
        });
      }
    }
  );

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, mode: isRealMode ? "real" : "mock", threshold: env.INTERVENTION_CONFIDENCE_THRESHOLD }, "Reasoning service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Reasoning service failed to start");
  Sentry.captureException(error);
  process.exit(1);
});
