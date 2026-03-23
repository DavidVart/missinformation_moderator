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
import { createHttpLogger, createLogger } from "@project-veritas/observability";
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

const logger = createLogger("notification-service", env.LOG_LEVEL);
const app = express();

app.use(cors());
app.use(createHttpLogger("notification-service", env.LOG_LEVEL));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "notification"
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
      if (!shouldPublishNotification(result, env.INTERVENTION_CONFIDENCE_THRESHOLD)) {
        return;
      }

      const message = createInterventionMessage(result);
      await xAddJson(redis, STREAM_NAMES.notificationsOutbound, message);
    }
  );

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Notification service listening");
  });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "Notification service failed to start");
  process.exit(1);
});
