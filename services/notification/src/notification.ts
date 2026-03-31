import type { ClaimVerificationResult } from "@project-veritas/contracts";
import { interventionMessageSchema } from "@project-veritas/contracts";
import { v4 as uuidv4 } from "uuid";

export function shouldPublishNotification(result: ClaimVerificationResult, threshold: number) {
  return (
    ["false", "misleading"].includes(result.verdict) &&
    result.confidence >= threshold
  );
}

function normalizeCorrection(correction: string) {
  return correction.replace(/\s+/g, " ").trim();
}

function takeLeadingSentences(text: string, count: number) {
  const sentences = text.match(/[^.!?]+[.!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length === 0) {
    return text.trim();
  }

  return sentences.slice(0, count).join(" ").trim();
}

export function condenseCorrection(correction: string) {
  const normalizedCorrection = normalizeCorrection(correction);
  const withoutFraming = normalizedCorrection
    .replace(/^the claim that .*? is (false|misleading)\.\s*/i, "")
    .replace(/^that claim is (false|misleading)\.\s*/i, "")
    .replace(/^(false|misleading)\.\s*/i, "")
    .trim();

  const conciseCorrection = takeLeadingSentences(withoutFraming || normalizedCorrection, 2);
  if (conciseCorrection.length <= 220) {
    return conciseCorrection;
  }

  return `${conciseCorrection.slice(0, 217).trimEnd().replace(/[,:;]$/, "")}...`;
}

export function createInterventionMessage(result: ClaimVerificationResult) {
  return interventionMessageSchema.parse({
    messageId: uuidv4(),
    sessionId: result.sessionId,
    userId: result.userId,
    mode: result.mode,
    claimId: result.claimId,
    claimText: result.claimText,
    verdict: result.verdict,
    confidence: result.confidence,
    correction: condenseCorrection(result.correction),
    sources: result.sources.map((source) => ({
      ...source,
      sourceType: source.sourceType ?? "web"
    })),
    issuedAt: new Date().toISOString()
  });
}
