import type { AudioChunkEnvelope } from "@project-veritas/contracts";
import { transcriptSegmentSchema } from "@project-veritas/contracts";
import { Sentry } from "@project-veritas/observability";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

export const whisperResponseSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1).optional()
});

export function resolveWhisperWorkerUrls(workerUrl: string) {
  const normalizedWorkerUrl = workerUrl.replace(/\/+$/, "");
  const workerUrls = [normalizedWorkerUrl];

  try {
    const parsedUrl = new URL(normalizedWorkerUrl);
    if (parsedUrl.hostname === "whisper-worker" || parsedUrl.hostname === "host.docker.internal") {
      const fallbackUrl = new URL(parsedUrl.toString());
      fallbackUrl.hostname = "127.0.0.1";
      workerUrls.push(fallbackUrl.toString().replace(/\/+$/, ""));
    }
  } catch {
    // Ignore malformed URLs here and let the fetch path surface the actual error.
  }

  return [...new Set(workerUrls)];
}

const TRANSCRIPTION_SYSTEM_PROMPT =
  "Transcribe conversational English faithfully for a live fact-checking app. Prefer literal wording, keep punctuation light, preserve names, places, and geopolitical terms exactly when possible, and avoid paraphrasing or inventing filler words. Common topics include politics, geopolitics, elections, wars, bombings, the Middle East, Iran, Israel, Gaza, Donald Trump, Joe Biden, Netanyahu, and Dubai.";

export function buildInitialPrompt(previousTranscript?: string) {
  const trimmedTranscript = previousTranscript?.trim();
  if (!trimmedTranscript) {
    return TRANSCRIPTION_SYSTEM_PROMPT;
  }

  return `${TRANSCRIPTION_SYSTEM_PROMPT} Previous context: ${trimmedTranscript}`;
}

type TranscriptToken = {
  normalized: string;
  original: string;
};

function tokenizeTranscript(text: string) {
  return text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => ({
      original: token,
      normalized: token.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, "")
    }))
    .filter((token) => token.normalized.length > 0) satisfies TranscriptToken[];
}

export function stripOverlappingPrefix(previousTranscript: string | undefined, currentTranscript: string) {
  const trimmedCurrentTranscript = currentTranscript.trim();
  if (!previousTranscript?.trim()) {
    return trimmedCurrentTranscript;
  }

  const previousTokens = tokenizeTranscript(previousTranscript);
  const currentTokens = tokenizeTranscript(trimmedCurrentTranscript);
  const maxOverlap = Math.min(previousTokens.length, currentTokens.length);

  for (let overlapSize = maxOverlap; overlapSize >= 3; overlapSize -= 1) {
    const previousSlice = previousTokens.slice(-overlapSize).map((token) => token.normalized).join(" ");
    const currentSlice = currentTokens.slice(0, overlapSize).map((token) => token.normalized).join(" ");

    if (previousSlice === currentSlice) {
      return currentTokens
        .slice(overlapSize)
        .map((token) => token.original)
        .join(" ")
        .trim();
    }
  }

  return trimmedCurrentTranscript;
}

/**
 * Build a WAV file buffer from raw PCM16 mono audio data.
 */
function buildWavBuffer(pcm16Bytes: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm16Bytes.byteLength;
  const fileSize = 36 + dataSize;

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);

  // fmt chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (sampleRate * channels * bytesPerSample)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16Bytes]);
}

/**
 * Transcribe audio using OpenAI's Whisper API.
 * Converts PCM16 Base64 audio to WAV and sends to /v1/audio/transcriptions.
 */
export async function transcribeWithOpenAI(
  apiKey: string,
  chunk: AudioChunkEnvelope,
  options?: { initialPrompt?: string }
) {
  const pcm16Bytes = new Uint8Array(Buffer.from(chunk.pcm16MonoBase64, "base64"));
  const wavBuffer = buildWavBuffer(pcm16Bytes, chunk.sampleRate);

  const formData = new FormData();
  formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  if (options?.initialPrompt) {
    formData.append("prompt", options.initialPrompt);
  }

  if (chunk.language) {
    formData.append("language", chunk.language);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown");
    throw new Error(`OpenAI Whisper API failed (${response.status}): ${errorBody}`);
  }

  const payload = await response.json();
  // verbose_json returns { text, language, duration, segments[] }
  // segments have avg_logprob which we can map to confidence
  const avgLogProb = payload.segments?.[0]?.avg_logprob;
  const confidence = avgLogProb != null ? Math.max(0, Math.min(1, 1 + avgLogProb)) : undefined;

  return whisperResponseSchema.parse({
    text: payload.text ?? "",
    confidence
  });
}

export async function transcribeWithWorker(
  workerUrl: string,
  chunk: AudioChunkEnvelope,
  options?: {
    initialPrompt?: string;
  }
) {
  let lastError: Error | undefined;

  for (const candidateWorkerUrl of resolveWhisperWorkerUrls(workerUrl)) {
    try {
      const response = await fetch(`${candidateWorkerUrl}/transcribe`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sessionId: chunk.sessionId,
          seq: chunk.seq,
          sampleRate: chunk.sampleRate,
          language: chunk.language,
          initialPrompt: options?.initialPrompt,
          pcm16MonoBase64: chunk.pcm16MonoBase64
        })
      });

      if (!response.ok) {
        throw new Error(`Whisper worker failed with status ${response.status}`);
      }

      const payload = await response.json();
      return whisperResponseSchema.parse(payload);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Whisper worker request failed");
}

export function createTranscriptSegment(
  chunk: AudioChunkEnvelope,
  text: string,
  confidence?: number
) {
  // V2: derive a human-friendly speakerLabel from the manual speakerRole.
  const speakerRole = chunk.speakerRole ?? "unknown";
  const speakerLabel = speakerRole === "self"
    ? "You"
    : speakerRole === "opponent"
      ? "Opponent"
      : "unknown";

  return transcriptSegmentSchema.parse({
    segmentId: uuidv4(),
    sessionId: chunk.sessionId,
    deviceId: chunk.deviceId,
    userId: chunk.userId,
    mode: chunk.mode,
    seq: chunk.seq,
    text,
    startedAt: chunk.startedAt,
    endedAt: chunk.endedAt,
    speakerLabel,
    speakerRole,
    confidence
  });
}

/**
 * V2 VAD gating — decide whether a chunk is worth transcribing.
 *
 * We compute the mean absolute sample value and peak sample value of the
 * decoded PCM16 audio. If both are below our silence thresholds, we skip
 * the chunk (don't call Whisper). This saves API cost and — more importantly —
 * prevents Whisper from hallucinating transcripts on silent/low-energy audio
 * ("Thanks for watching!", "Please subscribe." are common Whisper ghosts).
 */
export function isChunkSilent(chunk: AudioChunkEnvelope): boolean {
  const pcm16Bytes = Buffer.from(chunk.pcm16MonoBase64, "base64");
  // PCM16 mono: each sample is 2 bytes, little-endian signed.
  const totalSamples = pcm16Bytes.byteLength / 2;
  if (totalSamples === 0) {
    return true;
  }

  let sumAbs = 0;
  let peakAbs = 0;

  // Sample every ~10th frame for speed — 4s @ 16kHz = 64k samples, reading
  // every byte is unnecessary for a silence check.
  const stride = 10;
  let counted = 0;
  for (let i = 0; i < pcm16Bytes.byteLength - 1; i += 2 * stride) {
    const sample = pcm16Bytes.readInt16LE(i);
    const absValue = Math.abs(sample);
    sumAbs += absValue;
    if (absValue > peakAbs) {
      peakAbs = absValue;
    }
    counted += 1;
  }

  const meanAbs = sumAbs / Math.max(counted, 1);
  // INT16 max is 32768. Mean abs < 80 (~0.0024 normalized) means near-silence.
  // Peak < 1500 (~0.046) means no speech transients.
  const isSilent = meanAbs < 80 && peakAbs < 1500;
  return isSilent;
}
