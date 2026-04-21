import type { AudioChunkEnvelope } from "@project-veritas/contracts";
import { transcriptSegmentSchema } from "@project-veritas/contracts";
import { Sentry } from "@project-veritas/observability";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

export const whisperResponseSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1).optional()
});

/**
 * Known Whisper hallucination patterns — phrases Whisper spits out when it
 * processes silence/noise/ambient audio and has to output *something*. These
 * come from Whisper's training data (lots of YouTube captions) and are NOT
 * real transcription. We drop segments that match these patterns.
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /^\s*thanks? for watching[.!]?\s*$/i,
  /^\s*thank you for watching[.!]?\s*$/i,
  /^\s*please subscribe[.!]?\s*$/i,
  /^\s*don'?t forget to subscribe[.!]?\s*$/i,
  /subscribe to (my|our|the|this) channel/i,
  /for more .* (videos|content),?\s*(subscribe|visit|check)/i,
  /like,?\s*comment,?\s*(and )?subscribe/i,
  /if you (enjoyed|liked|like) this video/i,
  /hit that (like|subscribe) button/i,
  /^\s*\[music\]\s*$/i,
  /^\s*\[applause\]\s*$/i,
  /^\s*\[.*?\]\s*$/i,     // any bracketed-only sound annotation
  /^\s*♪.*♪\s*$/,          // music note markers
  /^\s*\(.*?\)\s*$/i,     // any parenthetical-only annotation
  /^\s*you\s*$/i,          // Whisper often emits a lone "you" on near-silence
  /^\s*bye\.?\s*$/i,       // or a lone "bye."
  /^\s*\.?\s*$/,           // empty or just punctuation
  /^\s*okay\.?\s*$/i,
  /^\s*thank you\.?\s*$/i
];

/**
 * Detect whether Whisper's response is likely hallucinated.
 * Uses three signals:
 *   1. Whisper's own `no_speech_prob` (>= 0.6 means Whisper itself isn't
 *      confident this is speech)
 *   2. `avg_logprob` < -1.0 means low confidence generally
 *   3. `compression_ratio` > 2.4 means the text is unusually repetitive (a
 *      hallmark of hallucinated loops like "you. you. you. you.")
 *   4. Pattern match against known YouTube-caption hallucinations.
 */
function isLikelyHallucination(
  text: string,
  segments: Array<{ no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number }> | undefined
): { hallucinated: boolean; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { hallucinated: true, reason: "empty" };
  }

  // Pattern match first — cheapest check
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { hallucinated: true, reason: `matched pattern ${pattern.source}` };
    }
  }

  if (!segments || segments.length === 0) {
    return { hallucinated: false, reason: "no segments" };
  }

  // Aggregate signal across all segments in this chunk
  let noSpeechSum = 0;
  let avgLogProbSum = 0;
  let compressionMax = 0;
  let counted = 0;

  for (const seg of segments) {
    if (typeof seg.no_speech_prob === "number") {
      noSpeechSum += seg.no_speech_prob;
      counted += 1;
    }
    if (typeof seg.avg_logprob === "number") {
      avgLogProbSum += seg.avg_logprob;
    }
    if (typeof seg.compression_ratio === "number" && seg.compression_ratio > compressionMax) {
      compressionMax = seg.compression_ratio;
    }
  }

  if (counted === 0) {
    return { hallucinated: false, reason: "no scoring signal" };
  }

  const avgNoSpeech = noSpeechSum / counted;
  const avgLogProb = avgLogProbSum / counted;

  if (avgNoSpeech >= 0.6) {
    return { hallucinated: true, reason: `no_speech_prob=${avgNoSpeech.toFixed(2)}` };
  }
  if (avgLogProb < -1.0) {
    return { hallucinated: true, reason: `avg_logprob=${avgLogProb.toFixed(2)}` };
  }
  if (compressionMax > 2.4) {
    return { hallucinated: true, reason: `compression_ratio=${compressionMax.toFixed(2)}` };
  }

  return { hallucinated: false, reason: "passed" };
}

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
  "Transcribe conversational English faithfully for a live fact-checking app. Speakers may have non-native accents — prefer the literal wording they produce, keep punctuation light, preserve names, places, and geopolitical terms exactly when possible, and avoid paraphrasing or inventing filler words. Common topics include politics, geopolitics, elections, wars, bombings, the Middle East, Iran, Israel, Gaza, Donald Trump, Joe Biden, Netanyahu, Dubai; US cities and states such as New York, Los Angeles, Chicago, San Francisco, Miami, Texas, Florida, California; and public figures such as Kamala Harris, Elon Musk, Vladimir Putin, Zelenskyy.";

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
  // gpt-4o-mini-transcribe: higher accuracy on accented English than whisper-1
  // and ~half the price ($0.003/min vs $0.006/min). Supports only json/text
  // response formats (no verbose_json), so the segment-level hallucination
  // signals (no_speech_prob/avg_logprob/compression_ratio) are unavailable —
  // we rely on the pattern-matching filter plus the client-side VAD.
  formData.append("model", "gpt-4o-mini-transcribe");
  formData.append("response_format", "json");

  if (options?.initialPrompt) {
    formData.append("prompt", options.initialPrompt);
  }

  // Default to English when the caller hasn't set a language. Explicit
  // language hints reduce Whisper auto-detect errors and hallucinations.
  formData.append("language", chunk.language && chunk.language.trim().length > 0 ? chunk.language : "en");

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
  // gpt-4o-mini-transcribe returns { text } (json format). No per-segment
  // confidence signals, so hallucination detection is pattern-only here.
  const rawText = typeof payload.text === "string" ? payload.text : "";

  // Reject known hallucinations ("Thanks for watching", "Subscribe to the
  // channel", lone "you" loops, etc.).
  const { hallucinated, reason } = isLikelyHallucination(rawText, undefined);
  if (hallucinated) {
    console.warn(`[transcription] dropping likely hallucination (${reason}): "${rawText.slice(0, 80)}"`);
    return whisperResponseSchema.parse({ text: "" });
  }

  return whisperResponseSchema.parse({
    text: rawText
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
 * decoded PCM16 audio. If BOTH are below our silence thresholds, we skip
 * the chunk (don't call Whisper). This saves API cost and — more importantly —
 * prevents Whisper from hallucinating transcripts on silent/low-energy audio
 * ("Thanks for watching!", "Please subscribe." are common Whisper ghosts).
 *
 * Thresholds tuned conservatively — iOS simulator's audio pipeline produces
 * noticeably quieter signals than a real device, so we err on the side of
 * letting chunks through. Whisper's own `no_speech_prob` + the hallucination
 * pattern filter (above) catch what VAD misses.
 */
export function isChunkSilent(chunk: AudioChunkEnvelope): boolean {
  const pcm16Bytes = Buffer.from(chunk.pcm16MonoBase64, "base64");
  const totalSamples = pcm16Bytes.byteLength / 2;
  if (totalSamples === 0) {
    return true;
  }

  let sumAbs = 0;
  let peakAbs = 0;

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
  // INT16 max is 32768. Only drop chunks that are TRULY silent:
  //   - mean < 30 (~0.0009 normalized) AND peak < 400 (~0.012)
  // Anything louder goes to Whisper, which has its own no_speech_prob gate.
  const isSilent = meanAbs < 30 && peakAbs < 400;
  return isSilent;
}
