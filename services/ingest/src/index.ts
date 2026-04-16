import { createServer } from "node:http";

import {
  CONSUMER_GROUPS,
  DEFAULT_SESSION_TTL_SECONDS,
  STREAM_NAMES,
  baseServiceEnvSchema,
  createEnv,
  createJsonConsumer,
  createRedisConnection,
  sessionMetaKey,
  sessionSocketKey,
  xAddJson
} from "@project-veritas/config";
import {
  audioChunkEnvelopeSchema,
  interventionMessageSchema,
  parseStreamPayload,
  sessionStartPayloadSchema,
  sessionStopPayloadSchema,
  socketAudioChunkPayloadSchema,
  transcriptSegmentSchema
} from "@project-veritas/contracts";
import { Sentry, createHttpLogger, createLogger, initSentry } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import {
  createAudioChunkEnvelope,
  createSessionStartedEvent,
  createSessionStoppedEvent
} from "./session.js";
import {
  buildInitialPrompt,
  createTranscriptSegment,
  isChunkSilent,
  stripOverlappingPrefix,
  transcribeWithOpenAI,
  transcribeWithWorker
} from "./transcription.js";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_SESSION_TTL_SECONDS),
  INGESTION_MOCK_MODE: z.coerce.boolean().default(false),
  WHISPER_WORKER_URL: z.string().default("http://whisper-worker:8000"),
  OPENAI_API_KEY: z.string().default(""),
  TRANSCRIPTION_CONTEXT_SEGMENTS: z.coerce.number().int().min(0).max(10).default(3)
});

initSentry("ingest-service");
const logger = createLogger("ingest-service", env.LOG_LEVEL);
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",")
  }
});

app.use(cors({ origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",") }));
app.use(createHttpLogger("ingest-service", env.LOG_LEVEL));

const useOpenAI = !!env.OPENAI_API_KEY;

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "ingest",
    mockMode: env.INGESTION_MOCK_MODE,
    transcriptionBackend: useOpenAI ? "openai" : "worker"
  });
});

type SessionMeta = {
  socketId: string;
  deviceId: string;
  userId?: string | undefined;
  mode: z.infer<typeof sessionStartPayloadSchema>["mode"];
  startedAt: string;
  chunkMs: number;
  sampleRate: number;
  preferredLanguage?: string | undefined;
};

function createMockTranscriptSegment(payload: z.infer<typeof socketAudioChunkPayloadSchema>) {
  const suffix =
    payload.seq === 1
      ? "Microphone stream established in local mock mode."
      : "Audio chunk received in local mock mode.";

      return transcriptSegmentSchema.parse({
        segmentId: uuidv4(),
        sessionId: payload.sessionId,
        mode: "debate_live",
        seq: payload.seq,
        text: `Chunk ${payload.seq}: ${suffix}`,
        startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    speakerLabel: "unknown",
    confidence: 0.55
  });
}

async function bootstrapMock() {
  const sessions = new Map<string, SessionMeta>();

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id, mockMode: true }, "Socket connected");

    socket.on("session:start", async (rawPayload, callback) => {
      try {
        const payload = sessionStartPayloadSchema.parse(rawPayload);
        const sessionId = uuidv4();
        const sessionEvent = createSessionStartedEvent(sessionId, payload);
        const sessionMeta = {
          socketId: socket.id,
          deviceId: payload.deviceId,
          userId: payload.userId,
          mode: payload.mode,
          startedAt: sessionEvent.startedAt,
          chunkMs: payload.chunkMs,
          sampleRate: payload.sampleRate,
          ...(payload.preferredLanguage ? { preferredLanguage: payload.preferredLanguage } : {})
        } satisfies SessionMeta;

        sessions.set(sessionId, sessionMeta);

        callback?.({
          ok: true,
          sessionId
        });
      } catch (error) {
        logger.error({ err: error, mockMode: true }, "Failed to start mock session");
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    socket.on("audio:chunk", async (rawPayload, callback) => {
      try {
        const payload = socketAudioChunkPayloadSchema.parse(rawPayload);
        const session = sessions.get(payload.sessionId);

        if (!session) {
          throw new Error(`Unknown session ${payload.sessionId}`);
        }

        callback?.({
          ok: true
        });

        socket.emit("transcript:update", createMockTranscriptSegment(payload));
      } catch (error) {
        logger.error({ err: error, mockMode: true }, "Failed to ingest mock audio chunk");
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    socket.on("session:stop", async (rawPayload, callback) => {
      try {
        const payload = sessionStopPayloadSchema.parse(rawPayload);
        const deleted = sessions.delete(payload.sessionId);

        if (!deleted) {
          throw new Error(`Unknown session ${payload.sessionId}`);
        }

        callback?.({
          ok: true
        });
      } catch (error) {
        logger.error({ err: error, mockMode: true }, "Failed to stop mock session");
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    socket.on("disconnect", () => {
      for (const [sessionId, session] of sessions.entries()) {
        if (session.socketId === socket.id) {
          sessions.delete(sessionId);
        }
      }

      logger.info({ socketId: socket.id, mockMode: true }, "Socket disconnected");
    });
  });

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, mockMode: true }, "Mock ingest service listening");
  });
}

async function bootstrap() {
  if (env.INGESTION_MOCK_MODE) {
    await bootstrapMock();
    return;
  }

  const redis = await createRedisConnection(env.REDIS_URL);
  const transcriptConsumer = await createRedisConnection(env.REDIS_URL);
  const notificationConsumer = await createRedisConnection(env.REDIS_URL);
  const audioChunkConsumer = await createRedisConnection(env.REDIS_URL);

  // ── Transcription state ──
  const transcriptContext = new Map<string, string[]>();
  const lastTranscriptBySession = new Map<string, string>();

  if (useOpenAI) {
    logger.info("Using OpenAI Whisper API for transcription");
  } else {
    logger.info({ workerUrl: env.WHISPER_WORKER_URL }, "Using self-hosted Whisper worker for transcription");
  }

  // ── Socket.IO handlers (from ingestion) ──
  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    socket.on("session:start", async (rawPayload, callback) => {
      try {
        const payload = sessionStartPayloadSchema.parse(rawPayload);
        const sessionId = uuidv4();
        const sessionEvent = createSessionStartedEvent(sessionId, payload);
        const storedSessionMeta = {
          deviceId: payload.deviceId,
          userId: payload.userId,
          mode: payload.mode,
          startedAt: sessionEvent.startedAt,
          chunkMs: payload.chunkMs,
          sampleRate: payload.sampleRate,
          ...(payload.preferredLanguage ? { preferredLanguage: payload.preferredLanguage } : {})
        };

        await redis.set(sessionSocketKey(sessionId), socket.id, {
          EX: env.SESSION_TTL_SECONDS
        });
        await redis.set(
          sessionMetaKey(sessionId),
          JSON.stringify(storedSessionMeta),
          { EX: env.SESSION_TTL_SECONDS }
        );
        await xAddJson(redis, STREAM_NAMES.sessions, sessionEvent);

        callback?.({
          ok: true,
          sessionId
        });
      } catch (error) {
        logger.error({ err: error }, "Failed to start session");
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    socket.on("audio:chunk", async (rawPayload, callback) => {
      try {
        const payload = socketAudioChunkPayloadSchema.parse(rawPayload);
        const metaRaw = await redis.get(sessionMetaKey(payload.sessionId));

        if (!metaRaw) {
          throw new Error(`Unknown session ${payload.sessionId}`);
        }

        const meta = z.object({
          deviceId: z.string(),
          userId: z.string().optional(),
          mode: sessionStartPayloadSchema.shape.mode,
          startedAt: z.string(),
          chunkMs: z.number().int().positive(),
          sampleRate: z.number().int().positive(),
          preferredLanguage: z.string().optional()
        }).parse(JSON.parse(metaRaw));

        const envelope = createAudioChunkEnvelope(
          meta.deviceId,
          meta.userId,
          meta.mode,
          meta.chunkMs,
          meta.sampleRate,
          meta.preferredLanguage,
          payload
        );

        // Update socket mapping on every chunk — handles socket reconnections
        await redis.set(sessionSocketKey(payload.sessionId), socket.id, {
          EX: env.SESSION_TTL_SECONDS
        });
        await redis.expire(sessionMetaKey(payload.sessionId), env.SESSION_TTL_SECONDS);
        await xAddJson(redis, STREAM_NAMES.audioChunks, envelope);

        callback?.({
          ok: true
        });
      } catch (error) {
        logger.error({ err: error }, "Failed to ingest audio chunk");
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    socket.on("session:stop", async (rawPayload, callback) => {
      try {
        const payload = sessionStopPayloadSchema.parse(rawPayload);
        const metaRaw = await redis.get(sessionMetaKey(payload.sessionId));

        if (!metaRaw) {
          throw new Error(`Unknown session ${payload.sessionId}`);
        }

        const meta = z.object({
          deviceId: z.string(),
          userId: z.string().optional(),
          mode: sessionStartPayloadSchema.shape.mode,
          startedAt: z.string(),
          chunkMs: z.number().int().positive(),
          sampleRate: z.number().int().positive(),
          preferredLanguage: z.string().optional()
        }).parse(JSON.parse(metaRaw));

        const sessionEvent = createSessionStoppedEvent(
          payload.sessionId,
          payload,
          meta.startedAt,
          meta.deviceId,
          meta.userId,
          meta.mode,
          meta.chunkMs,
          meta.sampleRate
        );

        await xAddJson(redis, STREAM_NAMES.sessions, sessionEvent);
        await redis.del(sessionMetaKey(payload.sessionId));
        // Keep socket mapping alive for 60s so late-arriving interventions still reach the client
        await redis.expire(sessionSocketKey(payload.sessionId), 60);

        callback?.({
          ok: true
        });
      } catch (error) {
        logger.error({ err: error }, "Failed to stop session");
        callback?.({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    socket.on("disconnect", () => {
      logger.info({ socketId: socket.id }, "Socket disconnected");
    });
  });

  // ── Relay transcript segments to client (from ingestion) ──
  void createJsonConsumer(
    transcriptConsumer,
    STREAM_NAMES.transcriptSegments,
    CONSUMER_GROUPS.ingestionTranscripts,
    `ingestion-transcripts-${uuidv4()}`,
    (value) => parseStreamPayload(value, transcriptSegmentSchema),
    async (_id, payload) => {
      const socketId = await redis.get(sessionSocketKey(payload.sessionId));
      if (socketId) {
        io.to(socketId).emit("transcript:update", payload);
      }
    }
  );

  // ── Relay intervention notifications to client (from ingestion) ──
  void createJsonConsumer(
    notificationConsumer,
    STREAM_NAMES.notificationsOutbound,
    CONSUMER_GROUPS.ingestionNotifications,
    `ingestion-notifications-${uuidv4()}`,
    (value) => parseStreamPayload(value, interventionMessageSchema),
    async (_id, payload) => {
      const socketId = await redis.get(sessionSocketKey(payload.sessionId));
      if (socketId) {
        io.to(socketId).emit("intervention:created", payload);
        logger.info({
          sessionId: payload.sessionId,
          socketId,
          verdict: payload.verdict
        }, "Forwarded intervention to client");
      } else {
        logger.warn({
          sessionId: payload.sessionId,
          verdict: payload.verdict
        }, "No active socket for session — intervention dropped");
        Sentry.captureMessage("Intervention dropped: no active socket for session", {
          level: "warning",
          tags: { sessionId: payload.sessionId },
          extra: { verdict: payload.verdict, claimText: payload.claimText }
        });
      }
    }
  );

  // ── Transcription consumer (from transcription service) ──
  void createJsonConsumer(
    audioChunkConsumer,
    STREAM_NAMES.audioChunks,
    CONSUMER_GROUPS.transcription,
    `transcription-${uuidv4()}`,
    (value) => parseStreamPayload(value, audioChunkEnvelopeSchema),
    async (_id, chunk) => {
      // V2 VAD gating: skip silent chunks before calling Whisper. Saves cost
      // and avoids hallucinated transcripts like "Thanks for watching" on
      // near-silent audio.
      if (isChunkSilent(chunk)) {
        logger.debug(
          { sessionId: chunk.sessionId, seq: chunk.seq },
          "Skipping silent audio chunk (VAD gate)"
        );
        return;
      }

      const sessionContext = transcriptContext.get(chunk.sessionId) ?? [];
      const prompt = buildInitialPrompt(sessionContext.join(" "));

      let transcription: { text: string; confidence?: number | undefined };

      try {
        if (useOpenAI) {
          transcription = await transcribeWithOpenAI(env.OPENAI_API_KEY, chunk, {
            initialPrompt: prompt
          });
        } else {
          transcription = await transcribeWithWorker(env.WHISPER_WORKER_URL, chunk, {
            initialPrompt: prompt
          });
        }
      } catch (error) {
        logger.error(
          { err: error, sessionId: chunk.sessionId, seq: chunk.seq },
          "Transcription failed for audio chunk"
        );
        Sentry.captureException(error, {
          tags: { sessionId: chunk.sessionId, seq: String(chunk.seq) },
          extra: {
            backend: useOpenAI ? "openai" : "worker",
            sampleRate: chunk.sampleRate,
            language: chunk.language
          }
        });
        return;
      }

      const nextText = stripOverlappingPrefix(lastTranscriptBySession.get(chunk.sessionId), transcription.text);
      lastTranscriptBySession.set(chunk.sessionId, transcription.text);

      if (!nextText.trim()) {
        return;
      }

      const segment = createTranscriptSegment(chunk, nextText, transcription.confidence);
      await xAddJson(redis, STREAM_NAMES.transcriptSegments, segment);

      logger.info(
        { sessionId: chunk.sessionId, seq: chunk.seq, textLength: nextText.length },
        "Transcript segment published"
      );

      const nextContext = [...sessionContext, nextText].slice(-env.TRANSCRIPTION_CONTEXT_SEGMENTS);
      transcriptContext.set(chunk.sessionId, nextContext);
    }
  );

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, transcriptionBackend: useOpenAI ? "openai" : "worker" }, "Ingest service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Ingest service failed to start");
  Sentry.captureException(error);
  process.exit(1);
});
