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
  claimVerificationResultSchema,
  cohortLeaderboardResponseSchema,
  interventionMessageSchema,
  parseStreamPayload,
  sessionEventSchema,
  topicMisinformationPointSchema,
  topicSlugSchema,
  topicSummarySchema,
  transcriptSegmentSchema
} from "@project-veritas/contracts";
import { Sentry, createHttpLogger, createLogger, initSentry } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import {
  createHistoryDatabase,
  persistClaimVerification,
  persistIntervention,
  persistSessionEvent,
  persistTranscriptSegment
} from "./database.js";
import { mapInterventions, mapSessionTranscript } from "./queries.js";
import {
  bootstrapAnalyticsSchema,
  generateMonthlyReflection,
  persistClaimAnalytics,
  persistTranscriptTopic,
  recomputeSessionScore,
  refreshSnapshots,
  resolveUserFromAuthSession
} from "./analytics.js";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4004),
  POSTGRES_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/veritas"),
  HISTORY_API_PREFIX: z.string().default("/api/history"),
  ANALYTICS_API_PREFIX: z.string().default("/api/analytics")
});

initSentry("data-service");

const logger = createLogger("data-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(express.json());
app.use(createHttpLogger("data-service", env.LOG_LEVEL));

async function bootstrap() {
  const pool = await createHistoryDatabase(env.POSTGRES_URL);
  await bootstrapAnalyticsSchema(pool);

  const redis = await createRedisConnection(env.REDIS_URL);

  // History consumers
  const historySessionConsumer = await createRedisConnection(env.REDIS_URL);
  const historyTranscriptConsumer = await createRedisConnection(env.REDIS_URL);
  const historyVerdictConsumer = await createRedisConnection(env.REDIS_URL);
  const historyNotificationConsumer = await createRedisConnection(env.REDIS_URL);

  // Analytics consumers
  const analyticsSessionConsumer = await createRedisConnection(env.REDIS_URL);
  const analyticsTranscriptConsumer = await createRedisConnection(env.REDIS_URL);
  const analyticsVerdictConsumer = await createRedisConnection(env.REDIS_URL);

  // ── Health ──
  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "data"
    });
  });

  // ══════════════════════════════════════════
  // History API routes (/api/history)
  // ══════════════════════════════════════════

  app.get(`${env.HISTORY_API_PREFIX}/sessions`, async (request, response) => {
    const userId = request.query.userId as string | undefined;
    const deviceId = request.query.deviceId as string | undefined;
    const limit = Math.min(Number(request.query.limit) || 50, 100);
    const offset = Number(request.query.offset) || 0;

    if (!userId && !deviceId) {
      response.status(400).json({ message: "userId or deviceId query parameter required" });
      return;
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (userId) {
      conditions.push(`s.user_id = $${paramIndex++}`);
      params.push(userId);
    }
    if (deviceId) {
      conditions.push(`s.device_id = $${paramIndex++}`);
      params.push(deviceId);
    }

    const whereClause = conditions.join(" OR ");
    const limitParam = paramIndex++;
    const offsetParam = paramIndex++;
    params.push(limit, offset);

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM sessions s WHERE ${whereClause}`,
      params.slice(0, -2)
    );

    const sessionsResult = await pool.query(
      `
        SELECT
          s.session_id,
          s.mode,
          s.status,
          s.started_at,
          s.stopped_at,
          COALESCE(EXTRACT(EPOCH FROM (s.stopped_at - s.started_at)) * 1000, 0)::bigint AS duration_ms,
          COALESCE(ts.segment_count, 0) AS segment_count,
          COALESCE(iv.correction_count, 0) AS correction_count,
          sc.accuracy_score
        FROM sessions s
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS segment_count
          FROM transcript_segments
          WHERE session_id = s.session_id
        ) ts ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS correction_count
          FROM interventions
          WHERE session_id = s.session_id
        ) iv ON true
        LEFT JOIN session_scores sc ON sc.session_id = s.session_id
        WHERE ${whereClause}
        ORDER BY s.started_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params
    );

    response.json({
      sessions: sessionsResult.rows.map((row: Record<string, unknown>) => ({
        sessionId: row.session_id,
        mode: row.mode,
        status: row.status,
        startedAt: row.started_at,
        stoppedAt: row.stopped_at ?? null,
        durationMs: Number(row.duration_ms),
        segmentCount: Number(row.segment_count),
        correctionCount: Number(row.correction_count),
        accuracyScore: row.accuracy_score != null ? Number(row.accuracy_score) : null
      })),
      total: Number(countResult.rows[0]?.total ?? 0)
    });
  });

  app.get(`${env.HISTORY_API_PREFIX}/sessions/:sessionId`, async (request, response) => {
    const { sessionId } = request.params;
    const sessionResult = await pool.query(
      "SELECT session_id, device_id, user_id, mode, status, started_at, stopped_at, chunk_ms, sample_rate FROM sessions WHERE session_id = $1",
      [sessionId]
    );

    if (sessionResult.rowCount === 0) {
      response.status(404).json({ message: "Session not found" });
      return;
    }

    const transcriptResult = await pool.query(
      `
        SELECT segment_id, device_id, user_id, mode, seq, text, started_at, ended_at, speaker_label, speaker_id, confidence
        FROM transcript_segments
        WHERE session_id = $1
        ORDER BY seq ASC
      `,
      [sessionId]
    );

    response.json({
      session: sessionResult.rows[0],
      transcript: mapSessionTranscript(transcriptResult.rows)
    });
  });

  app.get(`${env.HISTORY_API_PREFIX}/sessions/:sessionId/interventions`, async (request, response) => {
    const { sessionId } = request.params;
    const result = await pool.query(
      `
        SELECT
          interventions.message_id,
          interventions.claim_id,
          interventions.user_id,
          interventions.mode,
          interventions.verdict,
          interventions.confidence,
          interventions.correction,
          interventions.issued_at,
          claims.claim_text,
          evidence_sources.title AS source_title,
          evidence_sources.url AS source_url,
          evidence_sources.snippet AS source_snippet,
          evidence_sources.published_at AS source_published_at,
          evidence_sources.source_type
        FROM interventions
        JOIN claims ON claims.claim_id = interventions.claim_id
        LEFT JOIN evidence_sources ON evidence_sources.claim_id = claims.claim_id
        WHERE interventions.session_id = $1
        ORDER BY interventions.issued_at DESC
      `,
      [sessionId]
    );

    response.json({
      interventions: mapInterventions(result.rows)
    });
  });

  // ══════════════════════════════════════════
  // Analytics API routes (/api/analytics)
  // ══════════════════════════════════════════

  app.put(`${env.ANALYTICS_API_PREFIX}/profile/sync`, async (request, response) => {
    const body = z.object({
      userId: z.string().min(1),
      displayName: z.string().min(1),
      email: z.string().email().optional(),
      avatar: z.string().optional(),
      school: z.string().optional(),
      major: z.string().optional(),
      country: z.string().optional(),
      bio: z.string().max(280).optional(),
      leaderboardVisibility: z.enum(["public", "private"]).default("private")
    }).safeParse(request.body);

    if (!body.success) {
      response.status(400).json({ message: "Invalid body", errors: body.error.issues });
      return;
    }

    const { userId, displayName, email, avatar, school, major, country, bio, leaderboardVisibility } = body.data;
    const resolvedEmail = email ?? `${userId}@clerk.user`;

    await pool.query(
      `DELETE FROM auth_sessions WHERE user_id IN (SELECT user_id FROM users WHERE email = $1 AND user_id != $2)`,
      [resolvedEmail, userId]
    );
    await pool.query(
      `DELETE FROM profiles WHERE user_id IN (SELECT user_id FROM users WHERE email = $1 AND user_id != $2)`,
      [resolvedEmail, userId]
    );
    await pool.query(
      `DELETE FROM users WHERE email = $1 AND user_id != $2`,
      [resolvedEmail, userId]
    );

    await pool.query(
      `
        INSERT INTO users (user_id, email, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()
      `,
      [userId, resolvedEmail]
    );

    await pool.query(
      `
        INSERT INTO profiles (user_id, display_name, avatar, school, major, country, bio, leaderboard_visibility, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          avatar = EXCLUDED.avatar,
          school = EXCLUDED.school,
          major = EXCLUDED.major,
          country = EXCLUDED.country,
          bio = EXCLUDED.bio,
          leaderboard_visibility = EXCLUDED.leaderboard_visibility,
          updated_at = NOW()
      `,
      [userId, displayName, avatar ?? null, school ?? null, major ?? null, country ?? null, bio ?? null, leaderboardVisibility]
    );

    response.json({ ok: true });
  });

  app.get(`${env.ANALYTICS_API_PREFIX}/reflections/monthly`, async (request, response) => {
    let userId: string | null = null;

    const session = await resolveUserFromAuthSession(pool, request.header("authorization"));
    if (session) {
      userId = String(session.user_id);
    } else if (typeof request.query.userId === "string" && request.query.userId.length > 0) {
      userId = request.query.userId;
    }

    if (!userId) {
      response.status(401).json({ message: "Unauthorized — provide Bearer token or userId query parameter" });
      return;
    }

    const month = z.string().regex(/^\d{4}-\d{2}$/).parse(
      typeof request.query.month === "string"
        ? request.query.month
        : new Date().toISOString().slice(0, 7)
    );

    const reflection = await generateMonthlyReflection(pool, userId, month);
    response.json(reflection);
  });

  app.get(`${env.ANALYTICS_API_PREFIX}/leaderboards/global`, async (_request, response) => {
    await refreshSnapshots(pool);
    const result = await pool.query(
      `
        SELECT user_id, display_name, avatar, school, major, score, sessions_count, corrections_count, rank
        FROM leaderboard_snapshots
        WHERE scope = 'global'
        ORDER BY rank ASC
      `
    );

    response.json({
      scope: "global",
      minimumCohortMet: true,
      entries: result.rows.map((row) => ({
        rank: Number(row.rank),
        userId: String(row.user_id),
        displayName: String(row.display_name),
        avatar: row.avatar ? String(row.avatar) : undefined,
        school: row.school ? String(row.school) : undefined,
        major: row.major ? String(row.major) : undefined,
        score: Number(Number(row.score).toFixed(2)),
        sessionsCount: Number(row.sessions_count),
        correctionsCount: Number(row.corrections_count)
      }))
    });
  });

  app.get(`${env.ANALYTICS_API_PREFIX}/leaderboards/schools`, async (_request, response) => {
    const result = await pool.query(
      `
        SELECT
          profiles.school AS label,
          AVG(session_scores.accuracy_score) AS score,
          COUNT(*)::int AS sessions_count,
          SUM(session_scores.false_claim_count + session_scores.misleading_claim_count)::int AS corrections_count,
          COUNT(DISTINCT sessions.user_id)::int AS public_user_count
        FROM session_scores
        JOIN sessions ON sessions.session_id = session_scores.session_id
        JOIN profiles ON profiles.user_id = sessions.user_id
        WHERE
          session_scores.eligible_for_leaderboard = TRUE
          AND profiles.leaderboard_visibility = 'public'
          AND COALESCE(NULLIF(TRIM(profiles.school), ''), '') != ''
        GROUP BY profiles.school
        HAVING COUNT(DISTINCT sessions.user_id) >= 5
        ORDER BY AVG(session_scores.accuracy_score) DESC, COUNT(*) DESC
        LIMIT 20
      `
    );

    response.json(cohortLeaderboardResponseSchema.parse({
      scope: "school",
      minimumCohortMet: result.rows.length > 0,
      entries: result.rows.map((row, index) => ({
        rank: index + 1,
        label: String(row.label),
        score: Number(Number(row.score).toFixed(2)),
        sessionsCount: Number(row.sessions_count),
        correctionsCount: Number(row.corrections_count),
        publicUserCount: Number(row.public_user_count)
      }))
    }));
  });

  app.get(`${env.ANALYTICS_API_PREFIX}/leaderboards/majors`, async (_request, response) => {
    const result = await pool.query(
      `
        SELECT
          profiles.major AS label,
          AVG(session_scores.accuracy_score) AS score,
          COUNT(*)::int AS sessions_count,
          SUM(session_scores.false_claim_count + session_scores.misleading_claim_count)::int AS corrections_count,
          COUNT(DISTINCT sessions.user_id)::int AS public_user_count
        FROM session_scores
        JOIN sessions ON sessions.session_id = session_scores.session_id
        JOIN profiles ON profiles.user_id = sessions.user_id
        WHERE
          session_scores.eligible_for_leaderboard = TRUE
          AND profiles.leaderboard_visibility = 'public'
          AND COALESCE(NULLIF(TRIM(profiles.major), ''), '') != ''
        GROUP BY profiles.major
        HAVING COUNT(DISTINCT sessions.user_id) >= 5
        ORDER BY AVG(session_scores.accuracy_score) DESC, COUNT(*) DESC
        LIMIT 20
      `
    );

    response.json(cohortLeaderboardResponseSchema.parse({
      scope: "major",
      minimumCohortMet: result.rows.length > 0,
      entries: result.rows.map((row, index) => ({
        rank: index + 1,
        label: String(row.label),
        score: Number(Number(row.score).toFixed(2)),
        sessionsCount: Number(row.sessions_count),
        correctionsCount: Number(row.corrections_count),
        publicUserCount: Number(row.public_user_count)
      }))
    }));
  });

  app.get(`${env.ANALYTICS_API_PREFIX}/leaderboards/topics/:topicSlug`, async (request, response) => {
    const topicSlug = topicSlugSchema.parse(request.params.topicSlug);
    const result = await pool.query(
      `
        SELECT
          sessions.user_id,
          profiles.display_name,
          profiles.avatar,
          profiles.school,
          profiles.major,
          AVG(session_topics.accuracy_score) AS score,
          COUNT(*)::int AS sessions_count,
          SUM(session_topics.misinformation_count)::int AS corrections_count
        FROM session_topics
        JOIN sessions ON sessions.session_id = session_topics.session_id
        JOIN profiles ON profiles.user_id = sessions.user_id
        WHERE
          session_topics.topic_slug = $1
          AND profiles.leaderboard_visibility = 'public'
          AND sessions.mode IN ('debate_live', 'conversation_score')
        GROUP BY sessions.user_id, profiles.display_name, profiles.avatar, profiles.school, profiles.major
        ORDER BY AVG(session_topics.accuracy_score) DESC, COUNT(*) DESC
        LIMIT 25
      `,
      [topicSlug]
    );

    response.json({
      scope: "topic",
      scopeValue: topicSlug,
      minimumCohortMet: true,
      entries: result.rows.map((row, index) => ({
        rank: index + 1,
        userId: String(row.user_id),
        displayName: String(row.display_name),
        avatar: row.avatar ? String(row.avatar) : undefined,
        school: row.school ? String(row.school) : undefined,
        major: row.major ? String(row.major) : undefined,
        score: Number(Number(row.score).toFixed(2)),
        sessionsCount: Number(row.sessions_count),
        correctionsCount: Number(row.corrections_count),
        topicSlug
      }))
    });
  });

  app.get(`${env.ANALYTICS_API_PREFIX}/topics/session/:sessionId`, async (request, response) => {
    const result = await pool.query(
      `
        SELECT topic_slug, topic_label, segment_count, claim_count, misinformation_count, accuracy_score, highlights_json
        FROM session_topics
        WHERE session_id = $1
        ORDER BY segment_count DESC, claim_count DESC
      `,
      [request.params.sessionId]
    );

    response.json({
      topics: result.rows.map((row) => topicSummarySchema.parse({
        topicSlug: topicSlugSchema.parse(String(row.topic_slug)),
        label: String(row.topic_label),
        segmentCount: Number(row.segment_count),
        claimCount: Number(row.claim_count),
        misinformationCount: Number(row.misinformation_count),
        accuracyScore: Number(Number(row.accuracy_score).toFixed(2)),
        highlights: Array.isArray(row.highlights_json) ? row.highlights_json.map(String) : []
      }))
    });
  });

  app.get(`${env.ANALYTICS_API_PREFIX}/topics/:topicSlug/misinformation`, async (request, response) => {
    const topicSlug = topicSlugSchema.parse(request.params.topicSlug);
    const result = await pool.query(
      `
        SELECT claims.claim_text, claims.verdict, claims.correction, claims.session_id, claims.checked_at
        FROM claim_topics
        JOIN claims ON claims.claim_id = claim_topics.claim_id
        WHERE claim_topics.topic_slug = $1 AND claims.verdict IN ('false', 'misleading')
        ORDER BY claims.checked_at DESC
        LIMIT 25
      `,
      [topicSlug]
    );

    response.json({
      points: result.rows.map((row) => topicMisinformationPointSchema.parse({
        claimText: String(row.claim_text),
        verdict: row.verdict,
        correction: String(row.correction),
        sessionId: String(row.session_id),
        checkedAt: String(row.checked_at)
      }))
    });
  });

  // ══════════════════════════════════════════
  // Redis Stream consumers
  // ══════════════════════════════════════════

  // History consumers
  void createJsonConsumer(
    historySessionConsumer,
    STREAM_NAMES.sessions,
    CONSUMER_GROUPS.historySessions,
    `history-sessions-${uuidv4()}`,
    (value) => parseStreamPayload(value, sessionEventSchema),
    async (_id, event) => {
      await persistSessionEvent(pool, event);
    }
  );

  void createJsonConsumer(
    historyTranscriptConsumer,
    STREAM_NAMES.transcriptSegments,
    CONSUMER_GROUPS.historyTranscripts,
    `history-transcripts-${uuidv4()}`,
    (value) => parseStreamPayload(value, transcriptSegmentSchema),
    async (_id, segment) => {
      await persistTranscriptSegment(pool, segment);
    }
  );

  void createJsonConsumer(
    historyVerdictConsumer,
    STREAM_NAMES.verdictsCompleted,
    CONSUMER_GROUPS.historyVerdicts,
    `history-verdicts-${uuidv4()}`,
    (value) => parseStreamPayload(value, claimVerificationResultSchema),
    async (_id, result) => {
      await persistClaimVerification(pool, result);
    }
  );

  void createJsonConsumer(
    historyNotificationConsumer,
    STREAM_NAMES.notificationsOutbound,
    CONSUMER_GROUPS.historyNotifications,
    `history-notifications-${uuidv4()}`,
    (value) => parseStreamPayload(value, interventionMessageSchema),
    async (_id, message) => {
      await persistIntervention(pool, message);
    }
  );

  // Analytics consumers
  void createJsonConsumer(
    analyticsTranscriptConsumer,
    STREAM_NAMES.transcriptSegments,
    CONSUMER_GROUPS.analyticsTranscripts,
    `analytics-transcripts-${uuidv4()}`,
    (value) => parseStreamPayload(value, transcriptSegmentSchema),
    async (_id, segment) => {
      const topic = await persistTranscriptTopic(pool, segment);
      await xAddJson(redis, STREAM_NAMES.topicsAnalyzed, {
        sessionId: segment.sessionId,
        userId: segment.userId,
        topicSlug: topic.topicSlug,
        label: topic.label,
        checkedAt: new Date().toISOString()
      });
    }
  );

  void createJsonConsumer(
    analyticsVerdictConsumer,
    STREAM_NAMES.verdictsCompleted,
    CONSUMER_GROUPS.analyticsVerdicts,
    `analytics-verdicts-${uuidv4()}`,
    (value) => parseStreamPayload(value, claimVerificationResultSchema),
    async (_id, result) => {
      const { topic, penalty } = await persistClaimAnalytics(pool, result);
      const score = await recomputeSessionScore(pool, result);
      await xAddJson(redis, STREAM_NAMES.topicsAnalyzed, {
        sessionId: result.sessionId,
        userId: result.userId,
        topicSlug: topic.topicSlug,
        label: topic.label,
        checkedAt: result.checkedAt
      });
      await xAddJson(redis, STREAM_NAMES.sessionScores, score);
      logger.info({
        sessionId: result.sessionId,
        claimId: result.claimId,
        topicSlug: topic.topicSlug,
        penalty,
        accuracyScore: score.accuracyScore
      }, "Updated analytics score");
    }
  );

  void createJsonConsumer(
    analyticsSessionConsumer,
    STREAM_NAMES.sessions,
    CONSUMER_GROUPS.analyticsSessions,
    `analytics-sessions-${uuidv4()}`,
    (value) => parseStreamPayload(value, sessionEventSchema),
    async (_id, event) => {
      if (event.status === "stopped" && event.userId) {
        const month = event.startedAt.slice(0, 7);
        const reflection = await generateMonthlyReflection(pool, event.userId, month);
        await xAddJson(redis, STREAM_NAMES.reflectionsGenerated, reflection);
      }
    }
  );

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Data service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Data service failed to start");
  Sentry.captureException(error);
  process.exit(1);
});
