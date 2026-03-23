import fs from "node:fs";
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:4000", {
  transports: ["websocket"],
  timeout: 5000,
});

const pcm16Mono = fs.readFileSync("/tmp/veritas-eiffel.pcm").toString("base64");
const startedAt = new Date().toISOString();
const endedAt = new Date(Date.now() + 4000).toISOString();
const wait = (event, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out waiting for " + event)), timeoutMs);
  socket.once(event, (payload) => {
    clearTimeout(timer);
    resolve(payload);
  });
});

await new Promise((resolve, reject) => {
  socket.on("connect", resolve);
  socket.on("connect_error", reject);
});

const session = await new Promise((resolve, reject) => {
  socket.emit("session:start", { deviceId: "codex-resume", chunkMs: 4000, sampleRate: 16000 }, (ack) => {
    if (!ack?.ok) {
      reject(new Error(ack?.error || "session:start failed"));
      return;
    }
    resolve(ack);
  });
});

const chunkClosedAt = Date.now();
socket.emit("audio:chunk", { sessionId: session.sessionId, seq: 1, startedAt, endedAt, pcm16Mono });

const transcript = await wait("transcript:update");
const intervention = await wait("intervention:created");
console.log(JSON.stringify({ transcript, intervention, latencyAfterChunkCloseMs: Date.now() - chunkClosedAt }, null, 2));

await new Promise((resolve) => socket.emit("session:stop", { sessionId: session.sessionId }, () => resolve()));
socket.close();
