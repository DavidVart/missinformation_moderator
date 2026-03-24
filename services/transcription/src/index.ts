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
import { Sentry, createHttpLogger, createLogger, initSentry } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import {
  buildInitialPrompt,
  createTranscriptSegment,
  stripOverlappingPrefix,
  transcribeWithOpenAI,
  transcribeWithWorker
} from "./transcription.js";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4001),
  WHISPER_WORKER_URL: z.string().default("http://whisper-worker:8000"),
  OPENAI_API_KEY: z.string().default(""),
  TRANSCRIPTION_CONTEXT_SEGMENTS: z.coerce.number().int().min(0).max(10).default(3)
});

// Initialize Sentry before anything else
initSentry("transcription-service");

const logger = createLogger("transcription-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(createHttpLogger("transcription-service", env.LOG_LEVEL));

// Determine transcription backend
const useOpenAI = !!env.OPENAI_API_KEY;
if (useOpenAI) {
  logger.info("Using OpenAI Whisper API for transcription");
} else {
  logger.info({ workerUrl: env.WHISPER_WORKER_URL }, "Using self-hosted Whisper worker for transcription");
}

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "transcription",
    backend: useOpenAI ? "openai" : "worker"
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

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, backend: useOpenAI ? "openai" : "worker" }, "Transcription service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Transcription service failed to start");
  Sentry.captureException(error);
  process.exit(1);
});
