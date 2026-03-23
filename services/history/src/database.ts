import type {
  ClaimVerificationResult,
  InterventionMessage,
  SessionEvent,
  TranscriptSegment
} from "@project-veritas/contracts";
import { Pool } from "pg";

export async function createHistoryDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  await bootstrapSchema(pool);
  return pool;
}

async function bootstrapSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      user_id TEXT,
      mode TEXT NOT NULL DEFAULT 'debate_live',
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      stopped_at TIMESTAMPTZ,
      chunk_ms INTEGER NOT NULL,
      sample_rate INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transcript_segments (
      segment_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      device_id TEXT,
      user_id TEXT,
      mode TEXT NOT NULL DEFAULT 'debate_live',
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ NOT NULL,
      speaker_label TEXT NOT NULL,
      speaker_id TEXT,
      confidence REAL
    );

    CREATE INDEX IF NOT EXISTS transcript_segments_session_seq_idx
      ON transcript_segments (session_id, seq);

    CREATE TABLE IF NOT EXISTS claims (
      claim_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      mode TEXT NOT NULL DEFAULT 'debate_live',
      claim_text TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      correction TEXT NOT NULL,
      checked_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_sources (
      id BIGSERIAL PRIMARY KEY,
      claim_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      snippet TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      source_type TEXT NOT NULL DEFAULT 'web'
    );

    CREATE INDEX IF NOT EXISTS evidence_sources_claim_idx
      ON evidence_sources (claim_id);

    CREATE TABLE IF NOT EXISTS interventions (
      message_id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT,
      mode TEXT NOT NULL DEFAULT 'debate_live',
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      correction TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS interventions_session_idx
      ON interventions (session_id, issued_at DESC);

    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'debate_live';
    ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS device_id TEXT;
    ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'debate_live';
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'debate_live';
    ALTER TABLE interventions ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE interventions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'debate_live';

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

    CREATE INDEX IF NOT EXISTS claim_topics_session_idx
      ON claim_topics (session_id, topic_slug);

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

    CREATE INDEX IF NOT EXISTS analytics_claims_session_canonical_idx
      ON analytics_claims (session_id, canonical_claim);

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

    CREATE INDEX IF NOT EXISTS leaderboard_scope_idx
      ON leaderboard_snapshots (scope, scope_value, rank);

    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar TEXT,
      school TEXT,
      major TEXT,
      country TEXT,
      bio TEXT,
      leaderboard_visibility TEXT NOT NULL DEFAULT 'private',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_magic_links (
      magic_link_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      device_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      access_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS news_articles (
      article_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      topic_slug TEXT NOT NULL,
      source_name TEXT NOT NULL,
      url TEXT NOT NULL,
      summary TEXT NOT NULL,
      why_it_matters TEXT NOT NULL,
      related_weak_point TEXT,
      published_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_topic_preferences (
      user_id TEXT NOT NULL,
      topic_slug TEXT NOT NULL,
      following BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, topic_slug)
    );

    CREATE TABLE IF NOT EXISTS user_saved_articles (
      user_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, article_id)
    );
  `);
}

export async function persistSessionEvent(pool: Pool, event: SessionEvent) {
  await pool.query(
    `
      INSERT INTO sessions (session_id, device_id, user_id, mode, status, started_at, stopped_at, chunk_ms, sample_rate, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (session_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        stopped_at = EXCLUDED.stopped_at,
        chunk_ms = EXCLUDED.chunk_ms,
        sample_rate = EXCLUDED.sample_rate,
        updated_at = NOW()
    `,
    [
      event.sessionId,
      event.deviceId,
      event.userId ?? null,
      event.mode,
      event.status,
      event.startedAt,
      event.stoppedAt ?? null,
      event.chunkMs,
      event.sampleRate
    ]
  );
}

export async function persistTranscriptSegment(pool: Pool, segment: TranscriptSegment) {
  await pool.query(
    `
      INSERT INTO transcript_segments (segment_id, session_id, device_id, user_id, mode, seq, text, started_at, ended_at, speaker_label, speaker_id, confidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (segment_id) DO NOTHING
    `,
    [
      segment.segmentId,
      segment.sessionId,
      segment.deviceId ?? null,
      segment.userId ?? null,
      segment.mode,
      segment.seq,
      segment.text,
      segment.startedAt,
      segment.endedAt,
      segment.speakerLabel,
      segment.speakerId ?? null,
      segment.confidence ?? null
    ]
  );
}

export async function persistClaimVerification(pool: Pool, result: ClaimVerificationResult) {
  await pool.query(
    `
      INSERT INTO claims (claim_id, session_id, user_id, mode, claim_text, verdict, confidence, correction, checked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (claim_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        mode = EXCLUDED.mode,
        verdict = EXCLUDED.verdict,
        confidence = EXCLUDED.confidence,
        correction = EXCLUDED.correction,
        checked_at = EXCLUDED.checked_at
    `,
    [
      result.claimId,
      result.sessionId,
      result.userId ?? null,
      result.mode,
      result.claimText,
      result.verdict,
      result.confidence,
      result.correction,
      result.checkedAt
    ]
  );

  await pool.query("DELETE FROM evidence_sources WHERE claim_id = $1", [result.claimId]);

  for (const citation of result.sources) {
    await pool.query(
      `
        INSERT INTO evidence_sources (claim_id, title, url, snippet, published_at, source_type)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        result.claimId,
        citation.title,
        citation.url,
        citation.snippet,
        citation.publishedAt ?? null,
        citation.sourceType
      ]
    );
  }
}

export async function persistIntervention(pool: Pool, message: InterventionMessage) {
  await pool.query(
    `
      INSERT INTO interventions (message_id, claim_id, session_id, user_id, mode, verdict, confidence, correction, issued_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (message_id) DO NOTHING
    `,
    [
      message.messageId,
      message.claimId,
      message.sessionId,
      message.userId ?? null,
      message.mode,
      message.verdict,
      message.confidence,
      message.correction,
      message.issuedAt
    ]
  );
}
