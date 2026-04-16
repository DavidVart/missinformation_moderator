import type { SessionStartPayload, SessionStopPayload, SocketAudioChunkPayload } from "@project-veritas/contracts";
import { audioChunkEnvelopeSchema, sessionEventSchema } from "@project-veritas/contracts";
import { v4 as uuidv4 } from "uuid";

export function createSessionStartedEvent(sessionId: string, payload: SessionStartPayload) {
  return sessionEventSchema.parse({
    eventId: uuidv4(),
    sessionId,
    deviceId: payload.deviceId,
    userId: payload.userId,
    mode: payload.mode,
    status: "started",
    startedAt: new Date().toISOString(),
    chunkMs: payload.chunkMs,
    sampleRate: payload.sampleRate
  });
}

export function createSessionStoppedEvent(
  sessionId: string,
  stopPayload: SessionStopPayload,
  sessionStartedAt: string,
  deviceId: string,
  userId: string | undefined,
  mode: SessionStartPayload["mode"],
  chunkMs: number,
  sampleRate: number
) {
  return sessionEventSchema.parse({
    eventId: uuidv4(),
    sessionId,
    deviceId,
    userId,
    mode,
    status: "stopped",
    startedAt: sessionStartedAt,
    stoppedAt: new Date().toISOString(),
    chunkMs,
    sampleRate
  });
}

export function createAudioChunkEnvelope(
  deviceId: string,
  userId: string | undefined,
  mode: SessionStartPayload["mode"],
  chunkMs: number,
  sampleRate: number,
  language: string | undefined,
  payload: SocketAudioChunkPayload
) {
  return audioChunkEnvelopeSchema.parse({
    eventId: uuidv4(),
    sessionId: payload.sessionId,
    deviceId,
    userId,
    mode,
    seq: payload.seq,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    chunkMs,
    sampleRate,
    language,
    // V2: forward the speaker role (self | opponent) the client attributed to
    // this chunk via its manual toggle.
    speakerRole: payload.speakerRole,
    pcm16MonoBase64: payload.pcm16Mono
  });
}
