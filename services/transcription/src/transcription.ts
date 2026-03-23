import type { AudioChunkEnvelope } from "@project-veritas/contracts";
import { transcriptSegmentSchema } from "@project-veritas/contracts";
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
    speakerLabel: "unknown",
    confidence
  });
}
