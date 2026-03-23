import { describe, expect, it } from "vitest";

import {
  buildInitialPrompt,
  createTranscriptSegment,
  resolveWhisperWorkerUrls,
  stripOverlappingPrefix
} from "../src/transcription.js";

describe("transcription helpers", () => {
  it("creates transcript segments with default speaker label", () => {
    const segment = createTranscriptSegment({
      eventId: "evt_1",
      sessionId: "session_1",
      deviceId: "device_1",
      seq: 1,
      startedAt: "2026-03-18T20:00:00.000Z",
      endedAt: "2026-03-18T20:00:04.000Z",
      chunkMs: 4000,
      sampleRate: 16000,
      pcm16MonoBase64: "AQID"
    }, "The Eiffel Tower is in Paris.", 0.9);

    expect(segment.speakerLabel).toBe("unknown");
    expect(segment.text).toContain("Eiffel Tower");
  });

  it("builds a prompt that carries previous transcript context", () => {
    const prompt = buildInitialPrompt("The Middle East is a conflict zone right now.");

    expect(prompt).toContain("Transcribe conversational English faithfully");
    expect(prompt).toContain("Previous context");
    expect(prompt).toContain("Middle East");
  });

  it("removes overlapping transcript prefixes between windows", () => {
    const nextText = stripOverlappingPrefix(
      "The Middle East is kind of a conflict zone right now, but Donald Trump never",
      "right now, but Donald Trump never bombed Iran, Dubai did."
    );

    expect(nextText).toBe("bombed Iran, Dubai did.");
  });

  it("adds a localhost fallback for docker-only whisper hostnames", () => {
    expect(resolveWhisperWorkerUrls("http://whisper-worker:8000")).toEqual([
      "http://whisper-worker:8000",
      "http://127.0.0.1:8000"
    ]);
  });
});
