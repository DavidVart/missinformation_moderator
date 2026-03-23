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
  audioChunkEnvelopeSchema,
  parseStreamPayload
} from "@project-veritas/contracts";
import { createHttpLogger, createLogger } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { buildInitialPrompt, createTranscriptSegment, stripOverlappingPrefix, transcribeWithWorker } from "./transcription.js";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4001),
  WHISPER_WORKER_URL: z.string().url().default("http://whisper-worker:8000"),
  TRANSCRIPTION_CONTEXT_SEGMENTS: z.coerce.number().int().min(0).max(10).default(3)
});

const logger = createLogger("transcription-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(createHttpLogger("transcription-service", env.LOG_LEVEL));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "transcription"
  });
});

async function bootstrap() {
  const redis = await createRedisConnection(env.REDIS_URL);
  const consumer = await createRedisConnection(env.REDIS_URL);
  const transcriptContext = new Map<string, string[]>();
  const lastTranscriptBySession = new Map<string, string>();

  void createJsonConsumer(
    consumer,
    STREAM_NAMES.audioChunks,
    CONSUMER_GROUPS.transcription,
    `transcription-${uuidv4()}`,
    (value) => parseStreamPayload(value, audioChunkEnvelopeSchema),
    async (_id, chunk) => {
      const sessionContext = transcriptContext.get(chunk.sessionId) ?? [];
      const transcription = await transcribeWithWorker(env.WHISPER_WORKER_URL, chunk, {
        initialPrompt: buildInitialPrompt(sessionContext.join(" "))
      });

      const nextText = stripOverlappingPrefix(lastTranscriptBySession.get(chunk.sessionId), transcription.text);
      lastTranscriptBySession.set(chunk.sessionId, transcription.text);

      if (!nextText.trim()) {
        return;
      }

      const segment = createTranscriptSegment(chunk, nextText, transcription.confidence);
      await xAddJson(redis, STREAM_NAMES.transcriptSegments, segment);

      const nextContext = [...sessionContext, nextText].slice(-env.TRANSCRIPTION_CONTEXT_SEGMENTS);
      transcriptContext.set(chunk.sessionId, nextContext);
    }
  );

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Transcription service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Transcription service failed to start");
  process.exit(1);
});
