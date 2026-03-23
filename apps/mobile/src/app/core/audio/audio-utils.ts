const TARGET_SAMPLE_RATE = 16000;

export function calculateChunkSampleCount(sampleRate: number, chunkMs: number) {
  return Math.round((sampleRate * chunkMs) / 1000);
}

export function downsampleBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate = TARGET_SAMPLE_RATE
) {
  if (outputSampleRate >= inputSampleRate) {
    return buffer;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accumulator = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accumulator += buffer[index] ?? 0;
      count += 1;
    }

    result[offsetResult] = count > 0 ? accumulator / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

export function mergeFloat32Arrays(left: Float32Array, right: Float32Array) {
  const merged = new Float32Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

export function float32ToInt16(buffer: Float32Array) {
  const int16 = new Int16Array(buffer.length);

  for (let index = 0; index < buffer.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, buffer[index] ?? 0));
    int16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return int16;
}

export function int16ToBase64(buffer: Int16Array) {
  const view = new Uint8Array(buffer.buffer);
  let binary = "";

  for (const value of view) {
    binary += String.fromCharCode(value);
  }

  return btoa(binary);
}

export function buildChunkPayload(
  samples: Float32Array,
  inputSampleRate: number,
  startedAt: string,
  endedAt: string
) {
  const downsampled = downsampleBuffer(samples, inputSampleRate);
  const pcm16 = float32ToInt16(downsampled);

  return {
    startedAt,
    endedAt,
    pcm16Mono: int16ToBase64(pcm16)
  };
}
