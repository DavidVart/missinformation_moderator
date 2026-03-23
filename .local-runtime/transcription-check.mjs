import fs from "node:fs";
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:4000", {
  transports: ["websocket"],
  timeout: 5000,
});

const pcm = fs.readFileSync("/tmp/veritas-middle-east.pcm");
const bytesPerChunk = 16000 * 2 * 4;
const chunkCount = Math.ceil(pcm.length / bytesPerChunk);
const transcripts = [];
const interventions = [];

socket.on("transcript:update", (payload) => transcripts.push(payload));
socket.on("intervention:created", (payload) => interventions.push(payload));

await new Promise((resolve, reject) => {
  socket.on("connect", resolve);
  socket.on("connect_error", reject);
});

const session = await new Promise((resolve, reject) => {
  socket.emit("session:start", {
    deviceId: "codex-transcription-check",
    chunkMs: 4000,
    sampleRate: 16000,
    preferredLanguage: "en",
  }, (ack) => {
    if (!ack?.ok) {
      reject(new Error(ack?.error || "session:start failed"));
      return;
    }
    resolve(ack);
  });
});

for (let index = 0; index < chunkCount; index += 1) {
  const startedAt = new Date(Date.now() + index * 4000).toISOString();
  const endedAt = new Date(Date.now() + (index + 1) * 4000).toISOString();
  const chunk = pcm.subarray(index * bytesPerChunk, (index + 1) * bytesPerChunk);

  await new Promise((resolve, reject) => {
    socket.emit("audio:chunk", {
      sessionId: session.sessionId,
      seq: index + 1,
      startedAt,
      endedAt,
      pcm16Mono: Buffer.from(chunk).toString("base64"),
    }, (ack) => {
      if (!ack?.ok) {
        reject(new Error(ack?.error || "audio:chunk failed"));
        return;
      }
      resolve();
    });
  });
}

await new Promise((resolve) => setTimeout(resolve, 12000));
await new Promise((resolve) => {
  socket.emit("session:stop", { sessionId: session.sessionId }, () => resolve());
});
socket.close();

console.log(JSON.stringify({ chunkCount, transcripts, interventions }, null, 2));
