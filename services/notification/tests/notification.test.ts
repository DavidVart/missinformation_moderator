import { describe, expect, it } from "vitest";

import { condenseCorrection, createInterventionMessage, shouldPublishNotification } from "../src/notification.js";

const verificationResult = {
  claimId: "claim_1",
  sessionId: "session_1",
  mode: "conversation_score" as const,
  transcriptSegmentIds: ["segment_1"],
  claimText: "The Eiffel Tower is in Berlin.",
  verdict: "false" as const,
  confidence: 0.91,
  correction: "It is in Paris.",
  sources: [],
  checkedAt: "2026-03-18T20:00:00.000Z"
};

describe("notification helpers", () => {
  it("publishes high-confidence false claims", () => {
    expect(shouldPublishNotification(verificationResult, 0.75)).toBe(true);
  });

  it("creates intervention payloads", () => {
    const message = createInterventionMessage(verificationResult);
    expect(message.claimId).toBe("claim_1");
    expect(message.verdict).toBe("false");
  });

  it("condenses long corrections into direct moderator text", () => {
    const condensed = condenseCorrection(
      "The claim that Democrats only won because they rigged the elections is false. There is no evidence that the general election was rigged. Election officials certified the results."
    );

    expect(condensed).toBe("There is no evidence that the general election was rigged. Election officials certified the results.");
  });
});
