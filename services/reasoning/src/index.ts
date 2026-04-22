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
  INTERVENTION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  // Tier 1: knobs that used to be hard-coded. Defaults are tuned to fix the
  // "only first claim is detected" bug: short rate-limit window + short dedup
  // TTL so genuinely distinct rapid claims still fire.
  INTERVENTION_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(5000),
  CLAIM_DEDUPE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  ROLLING_WINDOW_SIZE: z.coerce.number().int().min(2).max(12).default(5),
  WINDOW_MIN_TOTAL_LENGTH: z.coerce.number().int().min(8).max(200).default(16)
});

initSentry("reasoning-service");

const logger = createLogger("reasoning-service", env.LOG_LEVEL);
const app = express();
const transcriptWindowTtlSeconds = 60 * 10;
const dedupeTtlSeconds = env.CLAIM_DEDUPE_TTL_SECONDS;
const rateLimitMs = env.INTERVENTION_RATE_LIMIT_MS;
const rollingWindowSize = env.ROLLING_WINDOW_SIZE;
const windowMinTotalLength = env.WINDOW_MIN_TOTAL_LENGTH;
// Recent-claim dedupe ZSET retention — claims older than this fall out of the
// per-session "have we seen this?" check. Mirrors dedupeTtlSeconds.
const recentClaimsTtlSeconds = Math.max(dedupeTtlSeconds, 30);

logger.info({
  rateLimitMs,
  dedupeTtlSeconds,
  rollingWindowSize,
  windowMinTotalLength,
  confidenceThreshold: env.INTERVENTION_CONFIDENCE_THRESHOLD
}, "Reasoning tunables loaded");

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

// Tier 1: per-session Redis keys for cross-instance coordination. Multiple
// reasoning workers (autoscaled / restarted) used to drift because rate-limit,
// last-assessed-signature, and recent-claims state lived in process memory.
function lastInterventionKey(sessionId: string) {
  return `session:${sessionId}:rl:lastInterventionAt`;
}

function lastSignatureKey(sessionId: string) {
  return `session:${sessionId}:lastAssessedSig`;
}

function recentClaimsKey(sessionId: string) {
  return `session:${sessionId}:recentClaims`;
}

async function bootstrap() {
  const redis = await createRedisConnection(env.REDIS_URL);
  const detectionConsumer = await createRedisConnection(env.REDIS_URL);
  const verificationConsumer = await createRedisConnection(env.REDIS_URL);
  const notificationConsumer = await createRedisConnection(env.REDIS_URL);

  /**
   * Tier 1: Redis-backed "have I assessed this exact 5-segment window before?"
   * check. Replaces the per-process Map so two reasoning instances handling
   * the same session don't both re-assess the same window (and don't BOTH
   * miss new windows after one of them restarts).
   */
  async function readLastSignature(sessionId: string): Promise<string | null> {
    return await redis.get(lastSignatureKey(sessionId));
  }

  async function writeLastSignature(sessionId: string, signature: string): Promise<void> {
    await redis.set(lastSignatureKey(sessionId), signature, {
      EX: transcriptWindowTtlSeconds
    });
  }

  /**
   * Tier 1: Redis LIST of recent claim entries (JSON-encoded {text, ts}) per
   * session. Capped at 24 entries; entries older than recentClaimsTtlSeconds
   * are filtered out on read. Used by the equivalence check that catches
   * duplicates the exact-match dedupe key alone would miss (small
   * paraphrasings / filler-word variants).
   *
   * SimpleRedisClient only supports GET/SET/LIST ops (no ZSET), hence the
   * list-with-timestamps pattern instead of a scored ZSET.
   */
  async function rememberClaim(sessionId: string, claimText: string): Promise<void> {
    const key = recentClaimsKey(sessionId);
    const entry = JSON.stringify({ text: claimText, ts: Date.now() });
    await redis.rPush(key, entry);
    await redis.lTrim(key, -24, -1);
    await redis.expire(key, recentClaimsTtlSeconds);
  }

  async function hasEquivalentRecentClaim(sessionId: string, claimText: string): Promise<boolean> {
    const key = recentClaimsKey(sessionId);
    const minTs = Date.now() - recentClaimsTtlSeconds * 1000;
    const entries = await redis.lRange(key, 0, -1);
    for (const raw of entries) {
      try {
        const parsed = JSON.parse(raw) as { text?: string; ts?: number };
        if (typeof parsed.text === "string" && (parsed.ts ?? 0) >= minTs) {
          if (claimsAreEquivalent(parsed.text, claimText)) {
            return true;
          }
        }
      } catch {
        // Skip malformed entries — will fall off the end via the 24-entry cap.
      }
    }
    return false;
  }

  /**
   * Tier 1: Redis-backed rate limit. Returns the elapsed ms since the last
   * intervention for this session, or null if there's no record. Atomically
   * updates the timestamp on a successful take().
   */
  async function takeRateLimitSlot(sessionId: string): Promise<{ allowed: boolean; sinceLastMs: number | null }> {
    if (rateLimitMs <= 0) {
      // Rate limiting disabled.
      return { allowed: true, sinceLastMs: null };
    }
    const key = lastInterventionKey(sessionId);
    const now = Date.now();
    const previous = await redis.get(key);
    const lastAt = previous ? Number(previous) : null;
    const sinceLastMs = lastAt ? now - lastAt : null;

    if (sinceLastMs !== null && sinceLastMs < rateLimitMs) {
      return { allowed: false, sinceLastMs };
    }

    // Take the slot. TTL = 2× rate-limit so stale records can't pin a
    // session to a permanent throttle if a reasoning instance dies right
    // after writing.
    await redis.set(key, String(now), { EX: Math.max(2, Math.ceil((rateLimitMs * 2) / 1000)) });
    return { allowed: true, sinceLastMs };
  }

  void createJsonConsumer(
    detectionConsumer,
    STREAM_NAMES.transcriptSegments,
    CONSUMER_GROUPS.reasoning,
    `reasoning-${uuidv4()}`,
    (value) => parseStreamPayload(value, transcriptSegmentSchema),
    async (_id, segment) => {
      const key = windowKey(segment.sessionId);
      // Pipeline: push + trim-to-N + read in as few round-trips as possible.
      // Tier 1: window expanded from 3 to ROLLING_WINDOW_SIZE (default 5) so
      // slow claims split across multiple segments stay together long enough
      // for the LLM to detect them.
      await redis.rPush(key, JSON.stringify(segment));
      await redis.lTrim(key, -rollingWindowSize, -1);
      const [rawSegments] = await Promise.all([
        redis.lRange(key, 0, -1),
        redis.expire(key, transcriptWindowTtlSeconds)
      ]);
      const segments = rawSegments.map((rawSegment) => transcriptSegmentSchema.parse(JSON.parse(rawSegment)));
      const rollingWindow = buildRollingWindow(segments, rollingWindowSize);
      const windowSignature = buildWindowSignature(rollingWindow, rollingWindowSize);

      const previousSignature = await readLastSignature(segment.sessionId);

      if (!shouldAssessWindow(rollingWindow, previousSignature, {
        minTotalLength: windowMinTotalLength,
        windowSize: rollingWindowSize
      })) {
        logger.debug({
          sessionId: segment.sessionId,
          seq: segment.seq,
          reason: "window-gate",
          signatureMatchedPrevious: windowSignature === previousSignature,
          windowChars: windowSignature.length
        }, "Skipping window");
        return;
      }

      await writeLastSignature(segment.sessionId, windowSignature);
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
      const equivalentSeen = !claimSeen && (await hasEquivalentRecentClaim(segment.sessionId, assessment.claimText));
      if (claimSeen || equivalentSeen) {
        logger.info({
          sessionId: segment.sessionId,
          seq: segment.seq,
          claimText: assessment.claimText,
          assessmentDurationMs,
          dedupeReason: claimSeen ? "exact-match" : "equivalent-claim"
        }, "Skipped duplicate claim assessment");
        return;
      }

      await redis.set(dedupeKey(segment.sessionId, assessment.claimText), "1", {
        EX: dedupeTtlSeconds
      });
      await rememberClaim(segment.sessionId, assessment.claimText);

      logger.info({
        sessionId: segment.sessionId,
        seq: segment.seq,
        claimText: assessment.claimText,
        assessmentDurationMs,
        detectionLagMs: Math.max(0, Date.now() - Date.parse(segment.endedAt)),
        windowSegmentCount: rollingWindow.length,
        speakerRole: assessment.speakerRole
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

  // Tier 1: rate limit was a hardcoded 15s in-memory Map, which dropped every
  // non-first correction in a rapid sequence AND failed to coordinate across
  // autoscaled instances. Now: INTERVENTION_RATE_LIMIT_MS env var (default 5s)
  // applied via a Redis-backed token check so multiple instances share state.

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

      const rateLimit = await takeRateLimitSlot(result.sessionId);
      if (!rateLimit.allowed) {
        logger.info({
          sessionId: result.sessionId,
          msSinceLast: rateLimit.sinceLastMs,
          rateLimitMs,
          claimText: result.claimText
        }, "Intervention rate-limited — dropped");
        return;
      }

      try {
        const message = createInterventionMessage(result);
        await xAddJson(redis, STREAM_NAMES.notificationsOutbound, message);
        logger.info({
          sessionId: result.sessionId,
          claimText: result.claimText,
          verdict: result.verdict,
          attributedTo: message.attributedTo,
          msSinceLast: rateLimit.sinceLastMs
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
