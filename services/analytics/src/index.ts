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
  monthlyReflectionSchema,
  parseStreamPayload,
  sessionEventSchema,
  sessionScoreSchema,
  topicMisinformationPointSchema,
  topicSlugSchema,
  topicSummarySchema,
  transcriptSegmentSchema,
  type ClaimVerificationResult,
  type TopicSlug
} from "@project-veritas/contracts";
import { createHttpLogger, createLogger } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4006),
  POSTGRES_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/veritas"),
  API_PREFIX: z.string().default("/api/analytics")
});

const logger = createLogger("analytics-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(express.json());
app.use(createHttpLogger("analytics-service", env.LOG_LEVEL));

const TOPIC_DEFINITIONS: Array<{
  slug: TopicSlug;
  label: string;
  keywords: string[];
}> = [
  { slug: "politics", label: "Politics", keywords: ["election", "president", "kamala", "trump", "biden", "senate", "government", "democrat", "republican"] },
  { slug: "economics", label: "Economics", keywords: ["tax", "inflation", "economy", "gdp", "recession", "market", "trade", "jobs", "tariff"] },
  { slug: "health", label: "Health", keywords: ["covid", "vaccine", "doctor", "hospital", "disease", "medicine", "health", "nutrition"] },
  { slug: "science", label: "Science", keywords: ["planet", "earth", "physics", "chemistry", "biology", "scientist", "research", "space"] },
  { slug: "technology", label: "Technology", keywords: ["ai", "software", "chip", "computer", "robot", "openai", "internet", "app", "device"] },
  { slug: "education", label: "Education", keywords: ["school", "college", "major", "student", "teacher", "campus", "education", "university"] },
  { slug: "law", label: "Law", keywords: ["law", "court", "judge", "legal", "constitution", "rights", "lawsuit", "crime"] },
  { slug: "culture", label: "Culture", keywords: ["movie", "music", "religion", "bible", "culture", "celebrity", "media", "society"] },
  { slug: "sports", label: "Sports", keywords: ["game", "score", "team", "championship", "soccer", "nba", "nfl", "baseball", "sports"] }
];

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalizeClaim(text: string) {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 3 && !["actually", "basically", "honestly", "just", "like", "really", "well"].includes(token))
    .join(" ");
}

function parseBearerToken(headerValue: string | undefined) {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token.trim();
}

async function resolveUserFromAuthSession(pool: Pool, authorizationHeader: string | undefined) {
  const accessToken = parseBearerToken(authorizationHeader);
  if (!accessToken) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT
        users.user_id,
        users.email,
        profiles.display_name,
        profiles.avatar,
        profiles.school,
        profiles.major,
        profiles.country,
        profiles.bio,
        profiles.leaderboard_visibility
      FROM auth_sessions
      JOIN users ON users.user_id = auth_sessions.user_id
      JOIN profiles ON profiles.user_id = users.user_id
      WHERE auth_sessions.access_token = $1 AND auth_sessions.expires_at > NOW()
    `,
    [accessToken]
  );

  return result.rows[0] ?? null;
}

function classifyTopic(text: string) {
  const normalized = normalizeText(text);
  let best = { slug: "general" as TopicSlug, label: "General", score: 0, matches: [] as string[] };

  for (const topic of TOPIC_DEFINITIONS) {
    const matches = topic.keywords.filter((keyword) => normalized.includes(keyword));
    if (matches.length > best.score) {
      best = {
        slug: topic.slug,
        label: topic.label,
        score: matches.length,
        matches
      };
    }
  }

  return {
    topicSlug: best.slug,
    label: best.label,
    highlights: best.matches.slice(0, 3)
  };
}

function calculatePenalty(verdict: ClaimVerificationResult["verdict"], confidence: number, repeatCount: number) {
  const basePenalty = verdict === "false"
    ? 14 * confidence
    : verdict === "misleading"
      ? 8 * confidence
      : 0;

  if (basePenalty === 0) {
    return 0;
  }

  return Number((basePenalty + repeatCount * (verdict === "false" ? 4 : 2) * confidence).toFixed(2));
}

function mergeHighlights(currentValue: unknown, additions: string[]) {
  const current = Array.isArray(currentValue) ? currentValue.map(String) : [];
  return [...new Set([...current, ...additions])].slice(0, 5);
}

async function bootstrapAnalyticsSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_scores (
      session_id TEXT PRIMARY KEY,
      user_id TEXT,
      mode TEXT NOT NULL,
      accuracy_score REAL NOT NULL,
      false_claim_count INTEGER NOT NULL DEFAULT 0,
      misleading_claim_count INTEGER NOT NULL DEFAULT 0,
      verified_claim_count INTEGER NOT NULL DEFAULT 0,
      repetition_penalty REAL NOT NULL DEFAULT 0,
      eligible_for_leaderboard BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS claim_topics (
      id BIGSERIAL PRIMARY KEY,
      claim_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT,
      topic_slug TEXT NOT NULL,
      topic_label TEXT NOT NULL,
      subtopic_slug TEXT,
      highlights_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session_topics (
      session_id TEXT NOT NULL,
      user_id TEXT,
      topic_slug TEXT NOT NULL,
      topic_label TEXT NOT NULL,
      segment_count INTEGER NOT NULL DEFAULT 0,
      claim_count INTEGER NOT NULL DEFAULT 0,
      misinformation_count INTEGER NOT NULL DEFAULT 0,
      accuracy_score REAL NOT NULL DEFAULT 100,
      highlights_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, topic_slug)
    );

    CREATE TABLE IF NOT EXISTS monthly_reflections (
      reflection_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      average_accuracy_score REAL NOT NULL,
      score_trend REAL NOT NULL,
      correction_count INTEGER NOT NULL,
      session_count INTEGER NOT NULL,
      top_topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      misinformation_hotspots_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      repeated_weak_points_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      rank_delta INTEGER,
      recommended_topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, month)
    );

    CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_value TEXT,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      school TEXT,
      major TEXT,
      score REAL NOT NULL,
      sessions_count INTEGER NOT NULL,
      corrections_count INTEGER NOT NULL,
      topic_slug TEXT,
      rank INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analytics_claims (
      claim_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      canonical_claim TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      penalty REAL NOT NULL DEFAULT 0,
      topic_slug TEXT NOT NULL DEFAULT 'general',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function upsertSessionTopic(pool: Pool, sessionId: string, userId: string | undefined, topic: ReturnType<typeof classifyTopic>, patch: {
  addSegments?: number;
  addClaims?: number;
  addMisinformation?: number;
}) {
  const current = await pool.query(
    `
      SELECT segment_count, claim_count, misinformation_count, accuracy_score, highlights_json
      FROM session_topics
      WHERE session_id = $1 AND topic_slug = $2
    `,
    [sessionId, topic.topicSlug]
  );

  const row = current.rows[0];
  const segmentCount = Number(row?.segment_count ?? 0) + (patch.addSegments ?? 0);
  const claimCount = Number(row?.claim_count ?? 0) + (patch.addClaims ?? 0);
  const misinformationCount = Number(row?.misinformation_count ?? 0) + (patch.addMisinformation ?? 0);
  const accuracyScore = claimCount === 0
    ? 100
    : Number(((1 - misinformationCount / claimCount) * 100).toFixed(2));
  const highlights = mergeHighlights(row?.highlights_json, topic.highlights);

  await pool.query(
    `
      INSERT INTO session_topics (
        session_id,
        user_id,
        topic_slug,
        topic_label,
        segment_count,
        claim_count,
        misinformation_count,
        accuracy_score,
        highlights_json,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
      ON CONFLICT (session_id, topic_slug)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        topic_label = EXCLUDED.topic_label,
        segment_count = EXCLUDED.segment_count,
        claim_count = EXCLUDED.claim_count,
        misinformation_count = EXCLUDED.misinformation_count,
        accuracy_score = EXCLUDED.accuracy_score,
        highlights_json = EXCLUDED.highlights_json,
        updated_at = NOW()
    `,
    [
      sessionId,
      userId ?? null,
      topic.topicSlug,
      topic.label,
      segmentCount,
      claimCount,
      misinformationCount,
      accuracyScore,
      JSON.stringify(highlights)
    ]
  );
}

async function persistTranscriptTopic(pool: Pool, segment: z.infer<typeof transcriptSegmentSchema>) {
  const topic = classifyTopic(segment.text);
  await upsertSessionTopic(pool, segment.sessionId, segment.userId, topic, { addSegments: 1 });
  return topic;
}

async function recomputeSessionScore(pool: Pool, result: ClaimVerificationResult) {
  const aggregates = await pool.query(
    `
      SELECT
        COALESCE(SUM(penalty), 0) AS penalty_total,
        COUNT(*) FILTER (WHERE verdict = 'false') AS false_count,
        COUNT(*) FILTER (WHERE verdict = 'misleading') AS misleading_count,
        COUNT(*) AS verified_count,
        COALESCE(SUM(
          CASE
            WHEN verdict = 'false' THEN GREATEST(penalty - (14 * confidence), 0)
            WHEN verdict = 'misleading' THEN GREATEST(penalty - (8 * confidence), 0)
            ELSE 0
          END
        ), 0) AS repetition_penalty
      FROM analytics_claims
      WHERE session_id = $1
    `,
    [result.sessionId]
  );

  const row = aggregates.rows[0];
  const accuracyScore = Math.max(0, Number((100 - Number(row?.penalty_total ?? 0)).toFixed(2)));
  const score = sessionScoreSchema.parse({
    sessionId: result.sessionId,
    userId: result.userId,
    mode: result.mode,
    accuracyScore,
    falseClaimCount: Number(row?.false_count ?? 0),
    misleadingClaimCount: Number(row?.misleading_count ?? 0),
    verifiedClaimCount: Number(row?.verified_count ?? 0),
    repetitionPenalty: Number(row?.repetition_penalty ?? 0),
    eligibleForLeaderboard: Boolean(result.userId) && ["debate_live", "conversation_score"].includes(result.mode),
    updatedAt: new Date().toISOString()
  });

  await pool.query(
    `
      INSERT INTO session_scores (
        session_id,
        user_id,
        mode,
        accuracy_score,
        false_claim_count,
        misleading_claim_count,
        verified_claim_count,
        repetition_penalty,
        eligible_for_leaderboard,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (session_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        mode = EXCLUDED.mode,
        accuracy_score = EXCLUDED.accuracy_score,
        false_claim_count = EXCLUDED.false_claim_count,
        misleading_claim_count = EXCLUDED.misleading_claim_count,
        verified_claim_count = EXCLUDED.verified_claim_count,
        repetition_penalty = EXCLUDED.repetition_penalty,
        eligible_for_leaderboard = EXCLUDED.eligible_for_leaderboard,
        updated_at = NOW()
    `,
    [
      score.sessionId,
      score.userId ?? null,
      score.mode,
      score.accuracyScore,
      score.falseClaimCount,
      score.misleadingClaimCount,
      score.verifiedClaimCount,
      score.repetitionPenalty,
      score.eligibleForLeaderboard
    ]
  );

  return score;
}

async function persistClaimAnalytics(pool: Pool, result: ClaimVerificationResult) {
  const topic = classifyTopic(`${result.claimText} ${result.correction}`);
  const canonicalClaim = canonicalizeClaim(result.claimText);
  const repeats = await pool.query(
    "SELECT COUNT(*)::int AS repeat_count FROM analytics_claims WHERE session_id = $1 AND canonical_claim = $2",
    [result.sessionId, canonicalClaim]
  );
  const repeatCount = Number(repeats.rows[0]?.repeat_count ?? 0);
  const penalty = calculatePenalty(result.verdict, result.confidence, repeatCount);

  await pool.query(
    `
      INSERT INTO analytics_claims (claim_id, session_id, user_id, canonical_claim, verdict, confidence, penalty, topic_slug)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (claim_id) DO NOTHING
    `,
    [
      result.claimId,
      result.sessionId,
      result.userId ?? null,
      canonicalClaim || normalizeText(result.claimText),
      result.verdict,
      result.confidence,
      penalty,
      topic.topicSlug
    ]
  );

  await pool.query("DELETE FROM claim_topics WHERE claim_id = $1", [result.claimId]);
  await pool.query(
    `
      INSERT INTO claim_topics (claim_id, session_id, user_id, topic_slug, topic_label, highlights_json)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      result.claimId,
      result.sessionId,
      result.userId ?? null,
      topic.topicSlug,
      topic.label,
      JSON.stringify(topic.highlights)
    ]
  );

  await upsertSessionTopic(pool, result.sessionId, result.userId, topic, {
    addClaims: 1,
    addMisinformation: ["false", "misleading"].includes(result.verdict) ? 1 : 0
  });

  return { topic, penalty };
}

function monthBounds(month: string) {
  const [year, monthValue] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year ?? 1970, (monthValue ?? 1) - 1, 1));
  const end = new Date(Date.UTC(year ?? 1970, monthValue ?? 1, 1));
  return { start, end };
}

async function computeRankDelta(pool: Pool, userId: string, month: string) {
  const { start, end } = monthBounds(month);
  const previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const previousEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

  const currentRankQuery = await pool.query(
    `
      WITH ranked AS (
        SELECT
          sessions.user_id,
          RANK() OVER (ORDER BY AVG(session_scores.accuracy_score) DESC) AS rank
        FROM session_scores
        JOIN sessions ON sessions.session_id = session_scores.session_id
        JOIN profiles ON profiles.user_id = sessions.user_id
        WHERE
          session_scores.eligible_for_leaderboard = TRUE
          AND profiles.leaderboard_visibility = 'public'
          AND sessions.started_at >= $1
          AND sessions.started_at < $2
        GROUP BY sessions.user_id
      )
      SELECT rank FROM ranked WHERE user_id = $3
    `,
    [start.toISOString(), end.toISOString(), userId]
  );

  const previousRankQuery = await pool.query(
    `
      WITH ranked AS (
        SELECT
          sessions.user_id,
          RANK() OVER (ORDER BY AVG(session_scores.accuracy_score) DESC) AS rank
        FROM session_scores
        JOIN sessions ON sessions.session_id = session_scores.session_id
        JOIN profiles ON profiles.user_id = sessions.user_id
        WHERE
          session_scores.eligible_for_leaderboard = TRUE
          AND profiles.leaderboard_visibility = 'public'
          AND sessions.started_at >= $1
          AND sessions.started_at < $2
        GROUP BY sessions.user_id
      )
      SELECT rank FROM ranked WHERE user_id = $3
    `,
    [previousStart.toISOString(), previousEnd.toISOString(), userId]
  );

  const currentRank = Number(currentRankQuery.rows[0]?.rank ?? 0);
  const previousRank = Number(previousRankQuery.rows[0]?.rank ?? 0);

  if (!currentRank || !previousRank) {
    return undefined;
  }

  return previousRank - currentRank;
}

async function generateMonthlyReflection(pool: Pool, userId: string, month: string) {
  const { start, end } = monthBounds(month);
  const previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const previousEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

  const summaryResult = await pool.query(
    `
      SELECT
        COALESCE(AVG(session_scores.accuracy_score), 0) AS average_accuracy_score,
        COALESCE(SUM(session_scores.false_claim_count + session_scores.misleading_claim_count), 0) AS correction_count,
        COUNT(*) AS session_count
      FROM session_scores
      JOIN sessions ON sessions.session_id = session_scores.session_id
      WHERE
        sessions.user_id = $1
        AND sessions.started_at >= $2
        AND sessions.started_at < $3
        AND sessions.mode != 'background_capture'
    `,
    [userId, start.toISOString(), end.toISOString()]
  );

  const previousSummaryResult = await pool.query(
    `
      SELECT COALESCE(AVG(session_scores.accuracy_score), 0) AS average_accuracy_score
      FROM session_scores
      JOIN sessions ON sessions.session_id = session_scores.session_id
      WHERE
        sessions.user_id = $1
        AND sessions.started_at >= $2
        AND sessions.started_at < $3
        AND sessions.mode != 'background_capture'
    `,
    [userId, previousStart.toISOString(), previousEnd.toISOString()]
  );

  const topicsResult = await pool.query(
    `
      SELECT
        session_topics.topic_slug,
        session_topics.topic_label,
        SUM(session_topics.segment_count)::int AS segment_count,
        SUM(session_topics.claim_count)::int AS claim_count,
        SUM(session_topics.misinformation_count)::int AS misinformation_count,
        COALESCE(AVG(session_topics.accuracy_score), 100) AS accuracy_score
      FROM session_topics
      JOIN sessions ON sessions.session_id = session_topics.session_id
      WHERE
        sessions.user_id = $1
        AND sessions.started_at >= $2
        AND sessions.started_at < $3
      GROUP BY session_topics.topic_slug, session_topics.topic_label
      ORDER BY SUM(session_topics.misinformation_count) DESC, SUM(session_topics.segment_count) DESC
      LIMIT 4
    `,
    [userId, start.toISOString(), end.toISOString()]
  );

  const hotspotsResult = await pool.query(
    `
      SELECT topic_slug, COUNT(*)::int AS count
      FROM claim_topics
      JOIN claims ON claims.claim_id = claim_topics.claim_id
      WHERE
        claim_topics.user_id = $1
        AND claims.checked_at >= $2
        AND claims.checked_at < $3
        AND claims.verdict IN ('false', 'misleading')
      GROUP BY topic_slug
      ORDER BY COUNT(*) DESC
      LIMIT 4
    `,
    [userId, start.toISOString(), end.toISOString()]
  );

  const weakPointsResult = await pool.query(
    `
      SELECT canonical_claim, COUNT(*)::int AS count
      FROM analytics_claims
      WHERE
        user_id = $1
        AND created_at >= $2
        AND created_at < $3
        AND verdict IN ('false', 'misleading')
      GROUP BY canonical_claim
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 4
    `,
    [userId, start.toISOString(), end.toISOString()]
  );

  const profileResult = await pool.query(
    "SELECT leaderboard_visibility FROM profiles WHERE user_id = $1",
    [userId]
  );

  const topTopics = topicsResult.rows.map((row) => topicSummarySchema.parse({
    topicSlug: topicSlugSchema.parse(String(row.topic_slug)),
    label: String(row.topic_label),
    segmentCount: Number(row.segment_count),
    claimCount: Number(row.claim_count),
    misinformationCount: Number(row.misinformation_count),
    accuracyScore: Number(Number(row.accuracy_score).toFixed(2)),
    highlights: []
  }));

  const misinformationHotspots = hotspotsResult.rows.map((row) => ({
    label: TOPIC_DEFINITIONS.find((topic) => topic.slug === row.topic_slug)?.label ?? "General",
    topicSlug: topicSlugSchema.parse(String(row.topic_slug)),
    count: Number(row.count)
  }));

  const repeatedWeakPoints = weakPointsResult.rows.map((row) => String(row.canonical_claim));
  const recommendedTopics = (misinformationHotspots.length > 0
    ? misinformationHotspots.map((hotspot) => hotspot.topicSlug)
    : topTopics.map((topic) => topic.topicSlug)
  ).slice(0, 3);

  const averageAccuracyScore = Number(Number(summaryResult.rows[0]?.average_accuracy_score ?? 0).toFixed(2));
  const previousAverage = Number(Number(previousSummaryResult.rows[0]?.average_accuracy_score ?? 0).toFixed(2));
  const rankDelta = String(profileResult.rows[0]?.leaderboard_visibility) === "public"
    ? await computeRankDelta(pool, userId, month)
    : undefined;

  const reflection = monthlyReflectionSchema.parse({
    reflectionId: uuidv4(),
    userId,
    month,
    averageAccuracyScore,
    scoreTrend: Number((averageAccuracyScore - previousAverage).toFixed(2)),
    correctionCount: Number(summaryResult.rows[0]?.correction_count ?? 0),
    sessionCount: Number(summaryResult.rows[0]?.session_count ?? 0),
    topTopics,
    misinformationHotspots,
    repeatedWeakPoints,
    rankDelta,
    recommendedTopics,
    generatedAt: new Date().toISOString()
  });

  await pool.query(
    `
      INSERT INTO monthly_reflections (
        reflection_id,
        user_id,
        month,
        average_accuracy_score,
        score_trend,
        correction_count,
        session_count,
        top_topics_json,
        misinformation_hotspots_json,
        repeated_weak_points_json,
        rank_delta,
        recommended_topics_json,
        generated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13)
      ON CONFLICT (user_id, month)
      DO UPDATE SET
        average_accuracy_score = EXCLUDED.average_accuracy_score,
        score_trend = EXCLUDED.score_trend,
        correction_count = EXCLUDED.correction_count,
        session_count = EXCLUDED.session_count,
        top_topics_json = EXCLUDED.top_topics_json,
        misinformation_hotspots_json = EXCLUDED.misinformation_hotspots_json,
        repeated_weak_points_json = EXCLUDED.repeated_weak_points_json,
        rank_delta = EXCLUDED.rank_delta,
        recommended_topics_json = EXCLUDED.recommended_topics_json,
        generated_at = EXCLUDED.generated_at
    `,
    [
      reflection.reflectionId,
      reflection.userId,
      reflection.month,
      reflection.averageAccuracyScore,
      reflection.scoreTrend,
      reflection.correctionCount,
      reflection.sessionCount,
      JSON.stringify(reflection.topTopics),
      JSON.stringify(reflection.misinformationHotspots),
      JSON.stringify(reflection.repeatedWeakPoints),
      reflection.rankDelta ?? null,
      JSON.stringify(reflection.recommendedTopics),
      reflection.generatedAt
    ]
  );

  return reflection;
}

async function refreshSnapshots(pool: Pool) {
  await pool.query("DELETE FROM leaderboard_snapshots");

  const globalRows = await pool.query(
    `
      SELECT
        sessions.user_id,
        profiles.display_name,
        profiles.avatar,
        profiles.school,
        profiles.major,
        AVG(session_scores.accuracy_score) AS score,
        COUNT(*)::int AS sessions_count,
        SUM(session_scores.false_claim_count + session_scores.misleading_claim_count)::int AS corrections_count
      FROM session_scores
      JOIN sessions ON sessions.session_id = session_scores.session_id
      JOIN profiles ON profiles.user_id = sessions.user_id
      WHERE session_scores.eligible_for_leaderboard = TRUE AND profiles.leaderboard_visibility = 'public'
      GROUP BY sessions.user_id, profiles.display_name, profiles.avatar, profiles.school, profiles.major
      ORDER BY AVG(session_scores.accuracy_score) DESC, COUNT(*) DESC
      LIMIT 50
    `
  );

  for (const [index, row] of globalRows.rows.entries()) {
    await pool.query(
      `
        INSERT INTO leaderboard_snapshots (
          snapshot_id, scope, scope_value, user_id, display_name, avatar, school, major, score, sessions_count, corrections_count, topic_slug, rank, updated_at
        )
        VALUES ($1, 'global', NULL, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, NOW())
      `,
      [
        uuidv4(),
        String(row.user_id),
        String(row.display_name),
        row.avatar ? String(row.avatar) : null,
        row.school ? String(row.school) : null,
        row.major ? String(row.major) : null,
        Number(Number(row.score).toFixed(2)),
        Number(row.sessions_count),
        Number(row.corrections_count),
        index + 1
      ]
    );
  }
}

async function bootstrap() {
  const pool = new Pool({
    connectionString: env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
  });
  await bootstrapAnalyticsSchema(pool);
  const redis = await createRedisConnection(env.REDIS_URL);
  const sessionConsumer = await createRedisConnection(env.REDIS_URL);
  const transcriptConsumer = await createRedisConnection(env.REDIS_URL);
  const verdictConsumer = await createRedisConnection(env.REDIS_URL);

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "analytics"
    });
  });

  app.get(`${env.API_PREFIX}/reflections/monthly`, async (request, response) => {
    const session = await resolveUserFromAuthSession(pool, request.header("authorization"));
    if (!session) {
      response.status(401).json({ message: "Unauthorized" });
      return;
    }

    const month = z.string().regex(/^\d{4}-\d{2}$/).parse(
      typeof request.query.month === "string"
        ? request.query.month
        : new Date().toISOString().slice(0, 7)
    );

    const reflection = await generateMonthlyReflection(pool, String(session.user_id), month);
    response.json(reflection);
  });

  app.get(`${env.API_PREFIX}/leaderboards/global`, async (_request, response) => {
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

  app.get(`${env.API_PREFIX}/leaderboards/schools`, async (_request, response) => {
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

  app.get(`${env.API_PREFIX}/leaderboards/majors`, async (_request, response) => {
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

  app.get(`${env.API_PREFIX}/leaderboards/topics/:topicSlug`, async (request, response) => {
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

  app.get(`${env.API_PREFIX}/topics/session/:sessionId`, async (request, response) => {
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

  app.get(`${env.API_PREFIX}/topics/:topicSlug/misinformation`, async (request, response) => {
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

  void createJsonConsumer(
    transcriptConsumer,
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
    verdictConsumer,
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
    sessionConsumer,
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
    logger.info({ port: env.PORT }, "Analytics service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Analytics service failed to start");
  process.exit(1);
});
