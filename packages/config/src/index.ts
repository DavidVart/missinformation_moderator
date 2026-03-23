import { config as loadDotEnv } from "dotenv";
import net from "node:net";
import tls from "node:tls";
import { z } from "zod";

loadDotEnv();

export const STREAM_NAMES = {
  sessions: "sessions.events",
  audioChunks: "audio.chunks",
  transcriptSegments: "transcripts.segments",
  claimsDetected: "claims.detected",
  verdictsCompleted: "verdicts.completed",
  notificationsOutbound: "notifications.outbound",
  topicsAnalyzed: "topics.analyzed",
  sessionScores: "sessions.scores",
  reflectionsGenerated: "reflections.generated",
  newsIngested: "news.ingested"
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
  ingestionNotifications: "ingestion-notifications",
  analyticsSessions: "analytics-sessions",
  analyticsTranscripts: "analytics-transcripts",
  analyticsVerdicts: "analytics-verdicts",
  analyticsScores: "analytics-scores",
  analyticsReflections: "analytics-reflections"
} as const;

export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;

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

type RedisPending = {
  resolve: (value: ParsedRedisValue) => void;
  reject: (error: Error) => void;
};

type XReadGroupMessage = {
  id: string;
  message: Record<string, string>;
};

type XReadGroupRecord = {
  name: string;
  messages: XReadGroupMessage[];
};

type RedisSetOptions = {
  EX?: number;
};

type ParsedRedisValue = string | number | null | ParsedRedisValue[] | Error;

export class SimpleRedisClient {
  private readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private readonly pending: RedisPending[] = [];

  constructor(private readonly url: string) {
    const redisUrl = new URL(url);
    const port = Number(redisUrl.port || "6379");
    const host = redisUrl.hostname || "127.0.0.1";
    const useTls = redisUrl.protocol === "rediss:";
    const password = redisUrl.password || undefined;

    if (useTls) {
      this.socket = tls.connect({
        host,
        port,
        rejectUnauthorized: true
      });
    } else {
      this.socket = net.createConnection({ host, port });
    }

    this.socket.setNoDelay(true);

    // If the URL contains a password, authenticate after connection
    if (password) {
      this.socket.once(useTls ? "secureConnect" : "connect", () => {
        this.sendCommand(["AUTH", decodeURIComponent(password)]).catch((error) => {
          console.error("Redis AUTH failed:", error);
        });
      });
    }

    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flushResponses();
    });

    this.socket.on("error", (error) => {
      this.failPending(error instanceof Error ? error : new Error(String(error)));
    });

    this.socket.on("close", () => {
      this.failPending(new Error(`Redis connection closed for ${this.url}`));
    });
  }

  async connect() {
    const redisUrl = new URL(this.url);
    const useTls = redisUrl.protocol === "rediss:";
    const connectEvent = useTls ? "secureConnect" : "connect";

    if (!this.socket.connecting) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.off(connectEvent, onConnect);
        this.socket.off("error", onError);
      };

      this.socket.once(connectEvent, onConnect);
      this.socket.once("error", onError);
    });
  }

  async quit() {
    try {
      await this.sendCommand(["QUIT"]);
    } catch {
      // Ignore quit failures during shutdown.
    }

    this.socket.end();
  }

  get(key: string) {
    return this.sendCommand(["GET", key]) as Promise<string | null>;
  }

  async set(key: string, value: string, options?: RedisSetOptions) {
    const args: Array<string | number> = ["SET", key, value];
    if (options?.EX) {
      args.push("EX", options.EX);
    }

    await this.sendCommand(args);
  }

  async del(key: string) {
    await this.sendCommand(["DEL", key]);
  }

  async expire(key: string, seconds: number) {
    await this.sendCommand(["EXPIRE", key, seconds]);
  }

  xAdd(streamName: string, id: string, payload: Record<string, string>) {
    const args: Array<string | number> = ["XADD", streamName, id];
    for (const [field, value] of Object.entries(payload)) {
      args.push(field, value);
    }

    return this.sendCommand(args) as Promise<string>;
  }

  async xGroupCreate(streamName: string, groupName: string, id: string, options?: { MKSTREAM?: boolean }) {
    const args: Array<string | number> = ["XGROUP", "CREATE", streamName, groupName, id];
    if (options?.MKSTREAM) {
      args.push("MKSTREAM");
    }

    await this.sendCommand(args);
  }

  async xReadGroup(
    groupName: string,
    consumerName: string,
    streams: { key: string; id: string },
    options?: { COUNT?: number; BLOCK?: number }
  ) {
    const args: Array<string | number> = ["XREADGROUP", "GROUP", groupName, consumerName];
    if (options?.COUNT) {
      args.push("COUNT", options.COUNT);
    }
    if (typeof options?.BLOCK === "number") {
      args.push("BLOCK", options.BLOCK);
    }
    args.push("STREAMS", streams.key, streams.id);

    const response = await this.sendCommand(args);
    if (response === null) {
      return null;
    }

    return normalizeXReadGroupResponse(response);
  }

  async xAck(streamName: string, groupName: string, id: string) {
    await this.sendCommand(["XACK", streamName, groupName, id]);
  }

  async rPush(key: string, value: string) {
    await this.sendCommand(["RPUSH", key, value]);
  }

  async lTrim(key: string, start: number, end: number) {
    await this.sendCommand(["LTRIM", key, start, end]);
  }

  lRange(key: string, start: number, end: number) {
    return this.sendCommand(["LRANGE", key, start, end]) as Promise<string[]>;
  }

  private flushResponses() {
    while (this.pending.length > 0) {
      const parsed = parseRedisValue(this.buffer);
      if (!parsed) {
        return;
      }

      this.buffer = this.buffer.subarray(parsed.offset);
      const next = this.pending.shift();
      if (!next) {
        continue;
      }

      if (parsed.value instanceof Error) {
        next.reject(parsed.value);
      } else {
        next.resolve(parsed.value);
      }
    }
  }

  private failPending(error: Error) {
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      next?.reject(error);
    }
  }

  private sendCommand(args: Array<string | number>) {
    return new Promise<ParsedRedisValue>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encodeRedisCommand(args));
    });
  }
}

export type RedisConnection = SimpleRedisClient;

type ParsedFrame = {
  value: ParsedRedisValue;
  offset: number;
};

function encodeRedisCommand(args: Array<string | number>) {
  const chunks = [`*${args.length}\r\n`];
  for (const arg of args) {
    const value = String(arg);
    chunks.push(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
  }

  return chunks.join("");
}

function parseRedisValue(buffer: Buffer): ParsedFrame | null {
  if (buffer.length === 0) {
    return null;
  }

  const prefixByte = buffer[0];
  if (typeof prefixByte !== "number") {
    return null;
  }

  const prefix = String.fromCharCode(prefixByte);
  const lineEnd = findLineEnd(buffer, 0);
  if (lineEnd === -1) {
    return null;
  }

  const line = buffer.toString("utf8", 1, lineEnd);

  switch (prefix) {
    case "+":
      return {
        value: line,
        offset: lineEnd + 2
      };
    case "-":
      return {
        value: new Error(line),
        offset: lineEnd + 2
      };
    case ":":
      return {
        value: Number(line),
        offset: lineEnd + 2
      };
    case "$": {
      const length = Number(line);
      if (length === -1) {
        return {
          value: null,
          offset: lineEnd + 2
        };
      }

      const start = lineEnd + 2;
      const end = start + length;
      if (buffer.length < end + 2) {
        return null;
      }

      return {
        value: buffer.toString("utf8", start, end),
        offset: end + 2
      };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) {
        return {
          value: null,
          offset: lineEnd + 2
        };
      }

      let offset = lineEnd + 2;
      const values: ParsedRedisValue[] = [];
      for (let index = 0; index < count; index += 1) {
        const nested = parseRedisValue(buffer.subarray(offset));
        if (!nested) {
          return null;
        }

        values.push(nested.value);
        offset += nested.offset;
      }

      return {
        value: values,
        offset
      };
    }
    default:
      throw new Error(`Unsupported Redis response prefix: ${prefix}`);
  }
}

function findLineEnd(buffer: Buffer, start: number) {
  for (let index = start; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }

  return -1;
}

function normalizeXReadGroupResponse(response: ParsedRedisValue) {
  const streamEntries = Array.isArray(response) ? response : [];
  return streamEntries.map((streamEntry) => {
    const [streamName, rawMessages] = Array.isArray(streamEntry) ? streamEntry : [];
    const messages = Array.isArray(rawMessages) ? rawMessages.map((rawMessage) => {
      const [id, rawFields] = Array.isArray(rawMessage) ? rawMessage : [];
      const message: Record<string, string> = {};

      if (Array.isArray(rawFields)) {
        for (let index = 0; index < rawFields.length; index += 2) {
          const field = rawFields[index];
          const value = rawFields[index + 1];
          if (typeof field === "string" && typeof value === "string") {
            message[field] = value;
          }
        }
      }

      return {
        id: typeof id === "string" ? id : "",
        message
      } satisfies XReadGroupMessage;
    }) : [];

    return {
      name: typeof streamName === "string" ? streamName : "",
      messages
    } satisfies XReadGroupRecord;
  });
}

export async function createRedisConnection(url: string): Promise<RedisConnection> {
  const client = new SimpleRedisClient(url);
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
