import { config as loadDotEnv } from "dotenv";
import { createClient } from "redis";
import { z } from "zod";

loadDotEnv();

export const STREAM_NAMES = {
  sessions: "sessions.events",
  audioChunks: "audio.chunks",
  transcriptSegments: "transcripts.segments",
  claimsDetected: "claims.detected",
  verdictsCompleted: "verdicts.completed",
  notificationsOutbound: "notifications.outbound"
} as const;

export const CONSUMER_GROUPS = {
  transcription: "transcription-service",
  reasoning: "reasoning-service",
  historySessions: "history-sessions",
  historyTranscripts: "history-transcripts",
  historyVerdicts: "history-verdicts",
  historyNotifications: "history-notifications",
  notification: "notification-service",
  ingestionTranscripts: "ingestion-transcripts",
  ingestionNotifications: "ingestion-notifications"
} as const;

export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
export type RedisConnection = ReturnType<typeof createClient>;

export const baseServiceEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  LOG_LEVEL: z.string().default("info")
});

export function createEnv<T extends z.ZodRawShape>(shape: T, source: Record<string, string | undefined> = process.env) {
  return z.object(shape).parse(source);
}

export function sessionSocketKey(sessionId: string) {
  return `session:${sessionId}:socket`;
}

export function sessionMetaKey(sessionId: string) {
  return `session:${sessionId}:meta`;
}

export async function createRedisConnection(url: string): Promise<RedisConnection> {
  const client = createClient({ url });
  await client.connect();
  return client;
}

export async function ensureConsumerGroup(
  client: RedisConnection,
  streamName: string,
  groupName: string
) {
  try {
    await client.xGroupCreate(streamName, groupName, "0", {
      MKSTREAM: true
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) {
      throw error;
    }
  }
}

export async function xAddJson<T>(
  client: RedisConnection,
  streamName: string,
  payload: T
) {
  return client.xAdd(streamName, "*", {
    payload: JSON.stringify(payload)
  });
}

export function parsePayloadField<T>(
  message: Record<string, string>,
  parser: (value: string) => T
) {
  const payload = message.payload;

  if (!payload) {
    throw new Error("Redis stream entry missing payload field");
  }

  return parser(payload);
}

export async function createJsonConsumer<T>(
  client: RedisConnection,
  streamName: string,
  groupName: string,
  consumerName: string,
  parser: (value: string) => T,
  onMessage: (id: string, payload: T) => Promise<void>,
  blockMs = 5000
) {
  await ensureConsumerGroup(client, streamName, groupName);

  while (true) {
    const records = await client.xReadGroup(groupName, consumerName, {
      key: streamName,
      id: ">"
    }, {
      COUNT: 10,
      BLOCK: blockMs
    });

    if (!records) {
      continue;
    }

    for (const streamRecord of records) {
      for (const message of streamRecord.messages) {
        try {
          const payload = parsePayloadField(message.message as Record<string, string>, parser);
          await onMessage(message.id, payload);
          await client.xAck(streamName, groupName, message.id);
        } catch (error) {
          console.error(`Failed processing Redis message ${message.id} from ${streamName}`, error);
        }
      }
    }
  }
}
