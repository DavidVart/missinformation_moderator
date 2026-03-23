import { describe, expect, it } from "vitest";

import { calculateChunkSampleCount, float32ToInt16, mergeFloat32Arrays } from "./audio-utils";

describe("audio utils", () => {
  it("merges float buffers", () => {
    const merged = mergeFloat32Arrays(new Float32Array([1, 2]), new Float32Array([3]));
    expect(Array.from(merged)).toEqual([1, 2, 3]);
  });

  it("converts floats to pcm16", () => {
    const pcm16 = float32ToInt16(new Float32Array([0, 1, -1]));
    expect(Array.from(pcm16)).toEqual([0, 32767, -32768]);
  });

  it("calculates chunk sizes from the source sample rate", () => {
    expect(calculateChunkSampleCount(48_000, 4_000)).toBe(192_000);
    expect(calculateChunkSampleCount(16_000, 4_000)).toBe(64_000);
  });
});
