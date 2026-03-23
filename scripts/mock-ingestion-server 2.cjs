const http = require("node:http");

const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const { z } = require("zod");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",")
  }
});

const sessionStartPayloadSchema = z.object({
  deviceId: z.string().min(1),
  chunkMs: z.literal(4000),
  sampleRate: z.literal(16000)
});

const socketAudioChunkPayloadSchema = z.object({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string(),
  pcm16Mono: z.string().min(1)
});

const sessionStopPayloadSchema = z.object({
  sessionId: z.string().min(1)
});

const sessions = new Map();

app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") }));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "mock-ingestion",
    host: HOST,
    port: PORT
  });
});

io.on("connection", (socket) => {
  console.log(`[mock-ingestion] socket connected ${socket.id}`);

  socket.on("session:start", (rawPayload, callback) => {
    try {
      const payload = sessionStartPayloadSchema.parse(rawPayload);
      const sessionId = uuidv4();

      sessions.set(sessionId, {
        socketId: socket.id,
        deviceId: payload.deviceId,
        chunkMs: payload.chunkMs,
        sampleRate: payload.sampleRate,
        startedAt: new Date().toISOString()
      });

      console.log(`[mock-ingestion] session started ${sessionId}`);
      callback?.({ ok: true, sessionId });
    } catch (error) {
      callback?.({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  socket.on("audio:chunk", (rawPayload, callback) => {
    try {
      const payload = socketAudioChunkPayloadSchema.parse(rawPayload);
      const session = sessions.get(payload.sessionId);

      if (!session) {
        throw new Error(`Unknown session ${payload.sessionId}`);
      }

      callback?.({ ok: true });

      socket.emit("transcript:update", {
        segmentId: uuidv4(),
        sessionId: payload.sessionId,
        seq: payload.seq,
        text:
          payload.seq === 1
            ? "Mock transcript: microphone stream is live."
            : `Mock transcript: received chunk ${payload.seq}.`,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        speakerLabel: "unknown",
        confidence: 0.55
      });
    } catch (error) {
      callback?.({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  socket.on("session:stop", (rawPayload, callback) => {
    try {
      const payload = sessionStopPayloadSchema.parse(rawPayload);
      sessions.delete(payload.sessionId);
      console.log(`[mock-ingestion] session stopped ${payload.sessionId}`);
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  socket.on("disconnect", () => {
    for (const [sessionId, session] of sessions.entries()) {
      if (session.socketId === socket.id) {
        sessions.delete(sessionId);
      }
    }

    console.log(`[mock-ingestion] socket disconnected ${socket.id}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-ingestion] listening on http://${HOST}:${PORT}`);
});
