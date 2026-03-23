import { describe, expect, it } from "vitest";

import {
  audioChunkEnvelopeSchema,
  parseStreamPayload,
  serializeStreamPayload
} from "../src/index.js";

describe("contracts", () => {
  it("round-trips stream payloads", () => {
    const payload = {
      eventId: "evt_123",
      sessionId: "session_123",
      deviceId: "device_123",
      userId: "user_123",
      mode: "debate_live",
      seq: 1,
      startedAt: "2026-03-18T20:00:00.000Z",
      endedAt: "2026-03-18T20:00:04.000Z",
      chunkMs: 4000,
      sampleRate: 16000,
      pcm16MonoBase64: "AQID"
    };

    const serialized = serializeStreamPayload(payload);
    const parsed = parseStreamPayload(serialized.payload, audioChunkEnvelopeSchema);

    expect(parsed).toEqual(payload);
  });
});
