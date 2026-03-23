import { describe, expect, it } from "vitest";

import { createAudioChunkEnvelope } from "../src/session.js";

describe("ingestion session helpers", () => {
  it("builds audio chunk envelopes", () => {
    const envelope = createAudioChunkEnvelope("device_1", 4000, 16000, {
      sessionId: "session_1",
      seq: 1,
      startedAt: "2026-03-18T20:00:00.000Z",
      endedAt: "2026-03-18T20:00:04.000Z",
      pcm16Mono: "AQID"
    });

    expect(envelope.deviceId).toBe("device_1");
    expect(envelope.chunkMs).toBe(4000);
    expect(envelope.sampleRate).toBe(16000);
  });
});
