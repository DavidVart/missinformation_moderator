import {
  CONSUMER_GROUPS,
  STREAM_NAMES,
  baseServiceEnvSchema,
  createEnv,
  createJsonConsumer,
  createRedisConnection,
  sessionMetaKey,
  xAddJson
} from "@project-veritas/config";
import {
  claimAssessmentSchema,
  claimVerificationResultSchema,
  parseStreamPayload,
  sensitivityLevelSchema,
  transcriptSegmentSchema,
  type SensitivityLevel,
  type SourceCitation
} from "@project-veritas/contracts";
import { Sentry, createHttpLogger, createLogger, initSentry } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import {
  buildRollingWindow,
  buildSoftVerification,
  buildWindowSignature,
  claimIdentityKey,
  claimsAreEquivalent,
  createReasoningEngine,
  createTopicExtractor,
  detectProfanity,
  fetchCitations,
  redactClaimText,
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
  WINDOW_MIN_TOTAL_LENGTH: z.coerce.number().int().min(8).max(200).default(16),
  // Tier 2.5: separate "we already corrected this for the user" memory from
  // the short detection dedup. Detection dedup has to be short so genuinely
  // re-stated claims still re-detect; intervention dedup needs to be long
  // so we don't double-correct the same fact mid-session (60s TTL was just
  // barely missing repeats — same claim corrected twice, 62s apart).
  INTERVENTION_SESSION_DEDUPE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(600),
  // Tier 2.5: how far back Tavily should look when assessment.timeSensitive
  // is true. 30 days was too narrow — anchor events (election, inauguration)
  // sat 12+ months back and never made it into the result set, so the
  // verifier wrongly returned "false" on still-true claims like "current
  // president = Trump".
  TAVILY_TIME_SENSITIVE_DAYS: z.coerce.number().int().positive().default(365)
});

initSentry("reasoning-service");

const logger = createLogger("reasoning-service", env.LOG_LEVEL);
const app = express();
const transcriptWindowTtlSeconds = 60 * 10;
const dedupeTtlSeconds = env.CLAIM_DEDUPE_TTL_SECONDS;
const rateLimitMs = env.INTERVENTION_RATE_LIMIT_MS;
const rollingWindowSize = env.ROLLING_WINDOW_SIZE;
const windowMinTotalLength = env.WINDOW_MIN_TOTAL_LENGTH;
const interventionSessionDedupeTtlSeconds = env.INTERVENTION_SESSION_DEDUPE_TTL_SECONDS;
const tavilyTimeSensitiveDays = env.TAVILY_TIME_SENSITIVE_DAYS;
// Recent-claim dedupe ZSET retention — claims older than this fall out of the
// per-session "have we seen this?" check. Mirrors dedupeTtlSeconds.
const recentClaimsTtlSeconds = Math.max(dedupeTtlSeconds, 30);

logger.info({
  rateLimitMs,
  dedupeTtlSeconds,
  interventionSessionDedupeTtlSeconds,
  tavilyTimeSensitiveDays,
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

// Tier 3: free-form topic label extracted via a tiny gpt-4o-mini call. The
// extractor is invoked at the verifier consumer in parallel with
// fetchCitations + verifyClaim, so the worst case adds zero wall time.
// A 3s timeout + "general" fallback guarantees an LLM hiccup never delays
// a correction reaching the user.
const extractTopic = createTopicExtractor({
  openAiApiKey: env.OPENAI_API_KEY,
  openAiModel: env.OPENAI_MODEL,
  timeoutMs: 3000
});

async function extractTopicWithFallback(
  sessionId: string,
  claimText: string,
  options: { correction?: string; sensitive?: boolean } = {}
): Promise<string> {
  try {
    return await extractTopic(claimText, options.correction);
  } catch (error) {
    // Tier 4+: redact when called for sensitive claim types (hate, profanity).
    // Topic extraction runs in parallel with the verifier for fact claims (so
    // claimText there is the user's normal claim and stays visible for
    // debugging) and for the soft-verdict path for opinion/hate (where the
    // hate utterance MUST stay out of Sentry). Caller passes sensitive=true
    // for hate; opinion stays un-redacted by design.
    const extra = options.sensitive ? redactClaimText(claimText) : { claimText };
    Sentry.captureException(error, {
      tags: { phase: "topic-extraction", sessionId },
      extra
    });
    logger.warn(
      { err: error, sessionId, ...extra },
      "Topic extraction failed — falling back to general"
    );
    return "general";
  }
}

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

// Tier 2.5: per-session "intervention already published for this canonical
// claim" guard. Sits at notification publish time, separate from the short
// detection-dedup TTL so we don't double-correct the user mid-session
// even when detection legitimately re-fires.
function correctedClaimKey(sessionId: string, claimText: string) {
  return `session:${sessionId}:corrected:${claimIdentityKey(claimText)}`;
}

/**
 * Tier 2 sensitivity selector: maps the per-session level chosen at
 * start-debate time into an effective base threshold. Strict +0.10 (fewer,
 * higher-precision corrections), Lenient -0.10 (more, higher-recall),
 * Balanced no change. The notification helper still applies its asymmetric
 * +0.10 for "self" claims on top of this, so Strict+self caps at 0.95.
 */
function thresholdForSensitivity(level: SensitivityLevel, baseThreshold: number): number {
  switch (level) {
    case "strict":
      return Math.min(0.95, baseThreshold + 0.10);
    case "lenient":
      return Math.max(0.5, baseThreshold - 0.10);
    case "balanced":
    default:
      return baseThreshold;
  }
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

  async function hasAlreadyCorrected(sessionId: string, claimText: string): Promise<boolean> {
    if (interventionSessionDedupeTtlSeconds <= 0) return false;
    const v = await redis.get(correctedClaimKey(sessionId, claimText));
    return v !== null;
  }

  async function markCorrected(sessionId: string, claimText: string): Promise<void> {
    if (interventionSessionDedupeTtlSeconds <= 0) return;
    await redis.set(correctedClaimKey(sessionId, claimText), "1", {
      EX: interventionSessionDedupeTtlSeconds
    });
  }

  /**
   * Read the sensitivity level the user picked at start-debate time. The
   * ingest service writes the per-session meta blob (deviceId, mode,
   * sensitivity, etc.) under sessionMetaKey at session:start; we read it
   * here and fall back to "balanced" if the meta is missing or malformed
   * so an old/legacy session never accidentally goes silent.
   */
  async function getSessionSensitivity(sessionId: string): Promise<SensitivityLevel> {
    try {
      const metaRaw = await redis.get(sessionMetaKey(sessionId));
      if (!metaRaw) return "balanced";
      const meta = JSON.parse(metaRaw) as { sensitivity?: unknown };
      const parsed = sensitivityLevelSchema.safeParse(meta.sensitivity ?? "balanced");
      return parsed.success ? parsed.data : "balanced";
    } catch {
      return "balanced";
    }
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
      // Tier 4 profanity check runs FIRST on the raw segment text so the
      // soft "back it up?" prompt fires immediately, independent of the
      // LLM's rolling-window detection. If the same utterance also contains
      // a verifiable factual claim, the LLM detection below picks that up
      // separately and both interventions can fire.
      const profanityHit = detectProfanity(segment.text);
      if (profanityHit.found) {
        try {
          const profanityAssessment = claimAssessmentSchema.parse({
            claimId: uuidv4(),
            sessionId: segment.sessionId,
            userId: segment.userId,
            mode: segment.mode,
            transcriptSegmentIds: [segment.segmentId],
            claimText: segment.text,
            query: segment.text,
            isVerifiable: false,
            confidence: 0.95, // regex hit is deterministic
            rationale: `Strong language detected: "${profanityHit.word}"`,
            speakerRole: segment.speakerRole ?? "unknown",
            timeSensitive: false,
            claimType: "profanity"
          });
          await xAddJson(redis, STREAM_NAMES.claimsDetected, profanityAssessment);
          logger.info({
            sessionId: segment.sessionId,
            seq: segment.seq,
            word: profanityHit.word,
            speakerRole: segment.speakerRole,
            detectionLagMs: Math.max(0, Date.now() - Date.parse(segment.endedAt))
          }, "Profanity detected — published synthetic claim");
        } catch (error) {
          // Tier 4+: do NOT pass the raw segment text or the matched word to
          // Sentry — profanity utterances live in the user's session and we
          // don't want them surfacing in our third-party error monitoring
          // backend (Sentry employees + anyone with project access can read
          // them). Use a deterministic hash + 3-word preview so on-call can
          // still cluster repeat incidents without seeing the full content.
          const redacted = redactClaimText(segment.text);
          logger.error(
            { err: error, claimTextHash: redacted.claimTextHash, claimTextPreview: redacted.claimTextPreview },
            "Failed to publish profanity assessment"
          );
          Sentry.captureException(error, {
            tags: { phase: "profanity", sessionId: segment.sessionId },
            extra: redacted
          });
        }
      }

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

      let assessments: Awaited<ReturnType<typeof reasoningEngine.assessWindow>>;
      try {
        assessments = await reasoningEngine.assessWindow(segment.sessionId, rollingWindow);
      } catch (error) {
        logger.error({ err: error, sessionId: segment.sessionId, seq: segment.seq }, "Claim detection failed");
        Sentry.captureException(error, {
          tags: { phase: "detection", sessionId: segment.sessionId },
          extra: { windowSignature, segmentText: segment.text }
        });
        return;
      }

      const assessmentDurationMs = Date.now() - assessmentStartedAtMs;

      logger.info({
        sessionId: segment.sessionId,
        seq: segment.seq,
        claimCount: assessments.length,
        assessmentDurationMs,
        windowSegmentCount: rollingWindow.length,
        windowChars: windowSignature.length
      }, assessments.length === 0 ? "No verifiable claims in window" : "Detected claims in window");

      if (assessments.length === 0) {
        return;
      }

      let publishedCount = 0;
      let dedupedCount = 0;
      for (const assessment of assessments) {
        const claimSeen = await redis.get(dedupeKey(segment.sessionId, assessment.claimText));
        const equivalentSeen = !claimSeen && (await hasEquivalentRecentClaim(segment.sessionId, assessment.claimText));
        if (claimSeen || equivalentSeen) {
          dedupedCount += 1;
          logger.info({
            sessionId: segment.sessionId,
            seq: segment.seq,
            claimText: assessment.claimText,
            dedupeReason: claimSeen ? "exact-match" : "equivalent-claim"
          }, "Skipped duplicate claim assessment");
          continue;
        }

        await redis.set(dedupeKey(segment.sessionId, assessment.claimText), "1", {
          EX: dedupeTtlSeconds
        });
        await rememberClaim(segment.sessionId, assessment.claimText);

        logger.info({
          sessionId: segment.sessionId,
          seq: segment.seq,
          claimText: assessment.claimText,
          confidence: assessment.confidence,
          speakerRole: assessment.speakerRole,
          detectionLagMs: Math.max(0, Date.now() - Date.parse(segment.endedAt))
        }, "Published claim candidate");
        await xAddJson(redis, STREAM_NAMES.claimsDetected, assessment);
        publishedCount += 1;
      }

      if (assessments.length > 1) {
        logger.info({
          sessionId: segment.sessionId,
          seq: segment.seq,
          totalDetected: assessments.length,
          publishedCount,
          dedupedCount
        }, "Multi-claim window summary");
      }
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

      // Tier 4: opinions, profanity, and hate short-circuit — no Tavily call,
      // no LLM verifier. Build a synthetic verification result that flows
      // through the same notification path so dedup / rate-limit /
      // per-session "already shown" all still apply, then the mobile renders
      // verdict="opinion" / verdict="profanity" / verdict="hate" as soft
      // chips rather than a red correction.
      if (
        assessment.claimType === "opinion" ||
        assessment.claimType === "profanity" ||
        assessment.claimType === "hate"
      ) {
        // Tier 3: profanity is the user's swearing — not topical, hardcode
        // "general" and skip the API call. Opinions DO get extraction since
        // "AI is dangerous" or "Trump is the best president" carry topical
        // content worth labelling on the chip. Hate is also topical (the
        // targeted group matters for analytics + Insights routing).
        const topic = assessment.claimType === "profanity"
          ? "general"
          : await extractTopicWithFallback(assessment.sessionId, assessment.claimText, {
              // Hate is sensitive; opinion is product signal and stays
              // un-redacted on Sentry (matches the log line below).
              sensitive: assessment.claimType === "hate"
            });

        const softVerification = buildSoftVerification(assessment, { topic });

        await xAddJson(redis, STREAM_NAMES.verdictsCompleted, softVerification);
        const outcome =
          assessment.claimType === "opinion" ? "opinion-flagged"
          : assessment.claimType === "hate" ? "hate-flagged"
          : "profanity-flagged";
        // Tier 4+: redact claimText in logs for sensitive types so the same
        // privacy guarantee that applies to Sentry also applies to log
        // aggregators (Render → external log providers). Opinion stays
        // un-redacted because the topic + opinion text is product signal
        // we want visible during dogfood.
        const claimTextField = assessment.claimType === "opinion"
          ? { claimText: assessment.claimText }
          : redactClaimText(assessment.claimText);
        logger.info({
          sessionId: assessment.sessionId,
          ...claimTextField,
          verdict: softVerification.verdict,
          confidence: assessment.confidence,
          topic,
          verificationDurationMs: Date.now() - verificationStartedAtMs,
          outcome
        }, "Completed claim verification");
        return;
      }

      // Tier 3: kick off topic extraction at the same instant as fetchCitations
      // so it overlaps with both the Tavily round-trip AND the verifyClaim LLM
      // call. By the time verifyClaim resolves, topicPromise is almost always
      // already settled, so we add zero wall-time. The 3s ceiling inside
      // extractTopicWithFallback caps the worst case if OpenAI is slow.
      const topicPromise = extractTopicWithFallback(assessment.sessionId, assessment.claimText);

      let citations: SourceCitation[];
      try {
        citations = await fetchCitations(assessment.query, env.TAVILY_API_KEY, {
          timeSensitive: assessment.timeSensitive,
          timeSensitiveDays: tavilyTimeSensitiveDays
        });
      } catch (error) {
        logger.error(
          { err: error, claimText: assessment.claimText, timeSensitive: assessment.timeSensitive },
          "Tavily citation fetch failed"
        );
        Sentry.captureException(error, {
          tags: { phase: "citation", sessionId: assessment.sessionId },
          extra: {
            query: assessment.query,
            claimText: assessment.claimText,
            timeSensitive: assessment.timeSensitive
          }
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

      const topic = await topicPromise;
      const verificationWithTopic = { ...verification, topic };
      await xAddJson(redis, STREAM_NAMES.verdictsCompleted, verificationWithTopic);

      // Observability: explicitly note the outcome class so true/unverified
      // claims are visible in logs (they previously went silently into the
      // "did not meet intervention criteria" path with no rationale).
      const outcome =
        verification.verdict === "true"
          ? "true-no-action"
          : verification.verdict === "unverified"
            ? "unverified-no-action"
            : "publishable";

      logger.info({
        sessionId: assessment.sessionId,
        claimText: assessment.claimText,
        verdict: verification.verdict,
        confidence: verification.confidence,
        citationCount: citations.length,
        topic,
        verificationDurationMs: Date.now() - verificationStartedAtMs,
        timeSensitive: assessment.timeSensitive,
        outcome
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

      const sensitivity = await getSessionSensitivity(result.sessionId);
      const effectiveThreshold = thresholdForSensitivity(sensitivity, env.INTERVENTION_CONFIDENCE_THRESHOLD);

      if (!shouldPublishNotification(result, effectiveThreshold)) {
        logger.info({
          sessionId: result.sessionId,
          verdict: result.verdict,
          confidence: result.confidence,
          speakerRole: result.speakerRole,
          threshold: effectiveThreshold,
          sensitivity
        }, "Verdict did not meet intervention criteria");
        return;
      }

      if (await hasAlreadyCorrected(result.sessionId, result.claimText)) {
        logger.info({
          sessionId: result.sessionId,
          claimText: result.claimText,
          verdict: result.verdict
        }, "Intervention session-deduped — already corrected this session");
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
        await markCorrected(result.sessionId, result.claimText);
        // Tier 4+: redact claimText in the success log too for sensitive
        // verdicts (hate, profanity) so log aggregators don't see what Sentry
        // doesn't. Opinion + factual corrections stay visible — those are
        // product signal we want available for dogfood + debugging.
        const isSensitive = result.verdict === "hate" || result.verdict === "profanity";
        const claimTextField = isSensitive
          ? redactClaimText(result.claimText)
          : { claimText: result.claimText };
        logger.info({
          sessionId: result.sessionId,
          ...claimTextField,
          verdict: result.verdict,
          attributedTo: message.attributedTo,
          msSinceLast: rateLimit.sinceLastMs,
          sensitivity,
          effectiveThreshold
        }, "Published intervention notification");
      } catch (error) {
        logger.error({ err: error, sessionId: result.sessionId }, "Failed to publish intervention");
        // Tier 4+: same sensitivity gate as the success log above.
        const isSensitive = result.verdict === "hate" || result.verdict === "profanity";
        const extra = isSensitive
          ? { ...redactClaimText(result.claimText), verdict: result.verdict }
          : { claimText: result.claimText, verdict: result.verdict };
        Sentry.captureException(error, {
          tags: { sessionId: result.sessionId },
          extra
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
