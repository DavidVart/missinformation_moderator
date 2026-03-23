import { describe, expect, it } from "vitest";

import {
  buildRollingWindow,
  canonicalizeClaimText,
  claimsAreEquivalent,
  curateCitations,
  shouldAssessWindow,
  shouldIntervene
} from "../src/reasoning-engine.js";

describe("reasoning helpers", () => {
  it("keeps the last three segments in order", () => {
    const window = buildRollingWindow([
      {
        segmentId: "3",
        sessionId: "session_1",
        seq: 3,
        text: "third",
        startedAt: "",
        endedAt: "",
        speakerLabel: "unknown"
      },
      {
        segmentId: "1",
        sessionId: "session_1",
        seq: 1,
        text: "first",
        startedAt: "",
        endedAt: "",
        speakerLabel: "unknown"
      },
      {
        segmentId: "2",
        sessionId: "session_1",
        seq: 2,
        text: "second",
        startedAt: "",
        endedAt: "",
        speakerLabel: "unknown"
      }
    ]);

    expect(window.map((segment) => segment.seq)).toEqual([1, 2, 3]);
  });

  it("gates interventions by verdict and confidence", () => {
    expect(shouldIntervene({
      claimId: "claim_1",
      sessionId: "session_1",
      transcriptSegmentIds: ["segment_1"],
      claimText: "The Eiffel Tower is in Berlin.",
      verdict: "false",
      confidence: 0.91,
      correction: "It is in Paris.",
      sources: [],
      checkedAt: "2026-03-18T20:00:00.000Z"
    }, 0.75)).toBe(true);
  });

  it("prefers authoritative citations over low-signal domains", () => {
    const curated = curateCitations([
      {
        title: "TOP 10 BEST Eiffel Tower in Berlin",
        url: "https://www.yelp.com/search?find_desc=Eiffel+Tower&find_loc=Berlin",
        snippet: "Top 10 Best Eiffel Tower near Berlin.",
        sourceType: "web"
      },
      {
        title: "Where is the Eiffel Tower located?",
        url: "https://www.reuters.com/world/europe/eiffel-tower-located-paris-france-2026-03-20/",
        snippet: "The Eiffel Tower is located in Paris, France.",
        publishedAt: "2026-03-20",
        sourceType: "web"
      },
      {
        title: "I'll tell my kids this is the Eiffel Tower",
        url: "https://www.reddit.com/r/berlin/comments/example",
        snippet: "Remember when the Eiffel Tower was in Berlin...",
        sourceType: "web"
      }
    ], "The Eiffel Tower is in Berlin.");

    expect(curated[0]?.url).toContain("reuters.com");
    expect(curated.some((citation) => citation.url.includes("yelp.com"))).toBe(false);
    expect(curated.some((citation) => citation.url.includes("reddit.com"))).toBe(false);
  });

  it("normalizes filler-heavy duplicate claims to the same meaning", () => {
    expect(canonicalizeClaimText("He actually like... never started any wars.")).toBe("never started wars");
    expect(claimsAreEquivalent(
      "He actually like... never started any wars.",
      "He never started any wars."
    )).toBe(true);
  });

  it("skips low-value fragment windows and evaluates complete statements", () => {
    const fragmentWindow = [
      {
        segmentId: "1",
        sessionId: "session_1",
        seq: 1,
        text: "Because...",
        startedAt: "",
        endedAt: "",
        speakerLabel: "unknown"
      },
      {
        segmentId: "2",
        sessionId: "session_1",
        seq: 2,
        text: "he actually like...",
        startedAt: "",
        endedAt: "",
        speakerLabel: "unknown"
      }
    ];

    const completeWindow = [
      ...fragmentWindow,
      {
        segmentId: "3",
        sessionId: "session_1",
        seq: 3,
        text: "never started any wars.",
        startedAt: "",
        endedAt: "",
        speakerLabel: "unknown"
      }
    ];

    expect(shouldAssessWindow(fragmentWindow)).toBe(false);
    expect(shouldAssessWindow(completeWindow)).toBe(true);
  });
});
