import type { ClaimVerificationResult } from "@project-veritas/contracts";
import { interventionMessageSchema } from "@project-veritas/contracts";
import { v4 as uuidv4 } from "uuid";

/**
 * V2: asymmetric confidence threshold.
 * When the claim was attributed to the user's own voice (SELF), require a
 * higher confidence to fire a correction — the user is much more annoyed if
 * we wrongly flag their opinions than if we miss some of their own errors.
 * Opponent claims use the baseline threshold (that's the whole point of the app).
 *
 * Tier 4: opinion verdicts go through with a fixed lower floor (0.6 detection
 * confidence). They're soft flags, not corrections — no Tavily/verifier
 * confidence to gate on, just the LLM's certainty that the utterance was
 * subjective. The asymmetric self-bump still applies so opponent opinions
 * surface a touch more readily than self ones.
 */
export function shouldPublishNotification(result: ClaimVerificationResult, baseThreshold: number) {
  if (result.verdict === "opinion") {
    const opinionFloor = 0.6;
    const threshold = result.speakerRole === "self"
      ? Math.min(0.85, opinionFloor + 0.10)
      : opinionFloor;
    return result.confidence >= threshold;
  }
  if (!["false", "misleading"].includes(result.verdict)) {
    return false;
  }
  const threshold = result.speakerRole === "self"
    ? Math.min(0.95, baseThreshold + 0.10)
    : baseThreshold;
  return result.confidence >= threshold;
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
    issuedAt: new Date().toISOString(),
    // V2: record which speaker's claim this correction is about, so the UI
    // can show "Opponent said: ..." or "You said: ..." and so the analytics
    // service can attribute the correction to the correct speaker's score.
    attributedTo: result.speakerRole ?? "unknown"
  });
}
