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
  parseStreamPayload
} from "@project-veritas/contracts";
import { Sentry, createHttpLogger, createLogger, initSentry } from "@project-veritas/observability";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { createInterventionMessage, shouldPublishNotification } from "./notification.js";

const env = createEnv({
  ...baseServiceEnvSchema.shape,
  PORT: z.coerce.number().int().positive().default(4003),
  INTERVENTION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75)
});

initSentry("notification-service");

const logger = createLogger("notification-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(createHttpLogger("notification-service", env.LOG_LEVEL));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "notification",
    confidenceThreshold: env.INTERVENTION_CONFIDENCE_THRESHOLD
  });
});

async function bootstrap() {
  const redis = await createRedisConnection(env.REDIS_URL);
  const consumer = await createRedisConnection(env.REDIS_URL);

  void createJsonConsumer(
    consumer,
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
        mode: result.mode
      }, "Received verdict");

      if (!shouldPublishNotification(result, env.INTERVENTION_CONFIDENCE_THRESHOLD)) {
        logger.info({
          sessionId: result.sessionId,
          verdict: result.verdict,
          confidence: result.confidence,
          mode: result.mode,
          threshold: env.INTERVENTION_CONFIDENCE_THRESHOLD
        }, "Verdict did not meet intervention criteria");
        return;
      }

      try {
        const message = createInterventionMessage(result);
        await xAddJson(redis, STREAM_NAMES.notificationsOutbound, message);
        logger.info({
          sessionId: result.sessionId,
          claimText: result.claimText,
          verdict: result.verdict
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
    logger.info({ port: env.PORT, threshold: env.INTERVENTION_CONFIDENCE_THRESHOLD }, "Notification service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Notification service failed to start");
  Sentry.captureException(error);
  process.exit(1);
});
