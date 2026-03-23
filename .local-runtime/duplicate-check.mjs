
import { io } from 'socket.io-client';
import { createRedisConnection, STREAM_NAMES, xAddJson } from '../packages/config/src/index.ts';

const socket = io('http://127.0.0.1:4000', { transports: ['websocket'], timeout: 5000 });
const redis = await createRedisConnection('redis://127.0.0.1:6379');
const interventions = [];
const transcripts = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

socket.on('transcript:update', (payload) => transcripts.push(payload));
socket.on('intervention:created', (payload) => interventions.push({ ...payload, receivedAt: new Date().toISOString() }));

await new Promise((resolve, reject) => {
  socket.on('connect', resolve);
  socket.on('connect_error', reject);
});

const session = await new Promise((resolve, reject) => {
  socket.emit('session:start', {
    deviceId: 'codex-duplicate-latency-check',
    chunkMs: 4000,
    sampleRate: 16000,
    preferredLanguage: 'en'
  }, (ack) => {
    if (!ack?.ok) {
      reject(new Error(ack?.error || 'session:start failed'));
      return;
    }
    resolve(ack);
  });
});

const sessionId = session.sessionId;
const baseMs = Date.now();
const segments = [
  'Because he actually like...',
  'never started any wars.',
  'He never started any wars.',
  'Kamala Harris was a terrorist.'
].map((text, index) => ({
  segmentId: crypto.randomUUID(),
  sessionId,
  seq: index + 1,
  text,
  startedAt: new Date(baseMs + index * 2000).toISOString(),
  endedAt: new Date(baseMs + index * 2000 + 4000).toISOString(),
  speakerLabel: 'unknown',
  confidence: 0.92
}));

for (const segment of segments) {
  await xAddJson(redis, STREAM_NAMES.transcriptSegments, segment);
}

await wait(14000);
await new Promise((resolve) => socket.emit('session:stop', { sessionId }, () => resolve()));
socket.close();
await redis.quit();

console.log(JSON.stringify({
  sessionId,
  interventions: interventions.map((item) => ({
    claimText: item.claimText,
    issuedAt: item.issuedAt,
    receivedAt: item.receivedAt,
    correction: item.correction
  })),
  interventionCount: interventions.length,
  transcriptEventCount: transcripts.length
}, null, 2));
