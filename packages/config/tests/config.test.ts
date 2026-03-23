import { describe, expect, it } from "vitest";

import { CONSUMER_GROUPS, STREAM_NAMES, sessionSocketKey } from "../src/index.js";

describe("config", () => {
  it("exposes stable stream names", () => {
    expect(STREAM_NAMES.audioChunks).toBe("audio.chunks");
    expect(CONSUMER_GROUPS.reasoning).toBe("reasoning-service");
    expect(STREAM_NAMES.sessionScores).toBe("sessions.scores");
  });

  it("builds socket keys", () => {
    expect(sessionSocketKey("abc")).toBe("session:abc:socket");
  });
});
