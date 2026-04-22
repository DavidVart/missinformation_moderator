import { describe, expect, it } from "vitest";

import {
  buildRollingWindow,
  canonicalizeClaimText,
  claimsAreEquivalent,
  curateCitations,
  shouldAssessWindow,
  shouldIntervene
} from "../src/reasoning-engine.js";

function seg(seq: number, text: string) {
  return {
    segmentId: String(seq),
    sessionId: "session_1",
    seq,
    text,
    startedAt: "",
    endedAt: "",
    speakerLabel: "unknown"
  } as const;
}

describe("reasoning helpers", () => {
  it("keeps the last five segments in order by default", () => {
    const window = buildRollingWindow([
      seg(3, "third"),
      seg(1, "first"),
      seg(2, "second"),
      seg(5, "fifth"),
      seg(4, "fourth"),
      seg(6, "sixth")
    ]);

    // Default window is 5 — drops "first" (seq 1), keeps 2..6 in order.
    expect(window.map((segment) => segment.seq)).toEqual([2, 3, 4, 5, 6]);
  });

  it("respects a custom window size", () => {
    const window = buildRollingWindow([seg(1, "a"), seg(2, "b"), seg(3, "c"), seg(4, "d")], 3);
    expect(window.map((segment) => segment.seq)).toEqual([2, 3, 4]);
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

  // Tier 1 regression: the old dedup treated these as equivalent because
  // they share 4 of 5 canonical tokens. They are NOT — the year differs,
  // and the year is the whole point of the claim.
  it("does not merge distinct claims that share filler but differ on a key number", () => {
    expect(
      claimsAreEquivalent("Trump won the 2016 election.", "Trump won the 2024 election.")
    ).toBe(false);

    expect(
      claimsAreEquivalent(
        "The S&P 500 was up 1.7 percent last quarter.",
        "The S&P 500 was up 3.2 percent last quarter."
      )
    ).toBe(false);
  });

  it("still merges paraphrases that share all their distinguishing tokens", () => {
    expect(
      claimsAreEquivalent(
        "Trump actually won the 2016 election.",
        "Trump won the 2016 election decisively."
      )
    ).toBe(true);
  });

  it("does not merge claims about different proper nouns", () => {
    expect(
      claimsAreEquivalent(
        "Iran attacked Israel in October.",
        "Iraq attacked Israel in October."
      )
    ).toBe(false);
  });

  it("skips low-value fragment windows and evaluates complete statements", () => {
    const fragmentWindow = [seg(1, "Because..."), seg(2, "he actually like...")];

    const completeWindow = [...fragmentWindow, seg(3, "never started any wars.")];

    expect(shouldAssessWindow(fragmentWindow)).toBe(false);
    expect(shouldAssessWindow(completeWindow)).toBe(true);
  });

  // Tier 1 regression: slow claims split across short segments used to be
  // gated out because the per-segment minimum was 8 chars. Now minimums
  // are 4 chars per segment + 16 total — enough for real speech rhythm.
  it("allows a claim split across several short segments to reach assessment", () => {
    const splitWindow = [
      seg(1, "The United States"),
      seg(2, "isn't actually"),
      seg(3, "a country in"),
      seg(4, "North America.")
    ];

    expect(shouldAssessWindow(splitWindow)).toBe(true);
  });

  it("re-evaluates a window once new content arrives but not before", () => {
    const first = [seg(1, "The population of France is forty million.")];
    const signature = "the population of france is forty million.";

    // Same signature → skip.
    expect(shouldAssessWindow(first, signature)).toBe(false);
    // New segment shifts signature → reassess.
    expect(shouldAssessWindow([...first, seg(2, "Actually it is sixty-eight million.")], signature)).toBe(true);
  });
});
