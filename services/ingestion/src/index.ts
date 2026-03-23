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
  interventionMessageSchema,
  parseStreamPayload,
  sessionStartPayloadSchema,
  sessionStopPayloadSchema,
  socketAudioChunkPayloadSchema,
  transcriptSegmentSchema
} from "@project-veritas/contracts";
import { createHttpLogger, createLogger } from "@project-veritas/observability";
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

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_SESSION_TTL_SECONDS),
  INGESTION_MOCK_MODE: z.coerce.boolean().default(false)
});

const logger = createLogger("ingestion-service", env.LOG_LEVEL);
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",")
  }
});

app.use(cors({ origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",") }));
app.use(createHttpLogger("ingestion-service", env.LOG_LEVEL));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "ingestion",
    mockMode: env.INGESTION_MOCK_MODE
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
    logger.info({ port: env.PORT, mockMode: true }, "Mock ingestion service listening");
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

        await redis.expire(sessionSocketKey(payload.sessionId), env.SESSION_TTL_SECONDS);
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
        await redis.del(sessionSocketKey(payload.sessionId));

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
      }
    }
  );

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Ingestion service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Ingestion service failed to start");
  process.exit(1);
});
