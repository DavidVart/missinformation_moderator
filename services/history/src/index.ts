import {
  CONSUMER_GROUPS,
  STREAM_NAMES,
  baseServiceEnvSchema,
  createEnv,
  createJsonConsumer,
  createRedisConnection
} from "@project-veritas/config";
import {
  claimVerificationResultSchema,
  interventionMessageSchema,
  parseStreamPayload,
  sessionEventSchema,
  transcriptSegmentSchema
} from "@project-veritas/contracts";
import { createHttpLogger, createLogger } from "@project-veritas/observability";
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

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4004),
  POSTGRES_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/veritas"),
  API_PREFIX: z.string().default("/api/history")
});

const logger = createLogger("history-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(createHttpLogger("history-service", env.LOG_LEVEL));

async function bootstrap() {
  const pool = await createHistoryDatabase(env.POSTGRES_URL);
  const sessionConsumer = await createRedisConnection(env.REDIS_URL);
  const transcriptConsumer = await createRedisConnection(env.REDIS_URL);
  const verdictConsumer = await createRedisConnection(env.REDIS_URL);
  const notificationConsumer = await createRedisConnection(env.REDIS_URL);

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "history"
    });
  });

  app.get(`${env.API_PREFIX}/sessions/:sessionId`, async (request, response) => {
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

  app.get(`${env.API_PREFIX}/sessions/:sessionId/interventions`, async (request, response) => {
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

  void createJsonConsumer(
    sessionConsumer,
    STREAM_NAMES.sessions,
    CONSUMER_GROUPS.historySessions,
    `history-sessions-${uuidv4()}`,
    (value) => parseStreamPayload(value, sessionEventSchema),
    async (_id, event) => {
      await persistSessionEvent(pool, event);
    }
  );

  void createJsonConsumer(
    transcriptConsumer,
    STREAM_NAMES.transcriptSegments,
    CONSUMER_GROUPS.historyTranscripts,
    `history-transcripts-${uuidv4()}`,
    (value) => parseStreamPayload(value, transcriptSegmentSchema),
    async (_id, segment) => {
      await persistTranscriptSegment(pool, segment);
    }
  );

  void createJsonConsumer(
    verdictConsumer,
    STREAM_NAMES.verdictsCompleted,
    CONSUMER_GROUPS.historyVerdicts,
    `history-verdicts-${uuidv4()}`,
    (value) => parseStreamPayload(value, claimVerificationResultSchema),
    async (_id, result) => {
      await persistClaimVerification(pool, result);
    }
  );

  void createJsonConsumer(
    notificationConsumer,
    STREAM_NAMES.notificationsOutbound,
    CONSUMER_GROUPS.historyNotifications,
    `history-notifications-${uuidv4()}`,
    (value) => parseStreamPayload(value, interventionMessageSchema),
    async (_id, message) => {
      await persistIntervention(pool, message);
    }
  );

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "History service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "History service failed to start");
  process.exit(1);
});
