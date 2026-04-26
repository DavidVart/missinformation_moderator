import { describe, expect, it } from "vitest";

import { claimAssessmentSchema } from "@project-veritas/contracts";

import { shouldPublishNotification } from "../src/notification.js";
import {
  buildRollingWindow,
  buildTavilyRequestBody,
  canonicalizeClaimText,
  claimsAreEquivalent,
  curateCitations,
  detectProfanity,
  isFragmentClaim,
  looksTruncated,
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

  // Tier 2: Tavily search bias for time-sensitive claims. Election results,
  // current prices, and other recent-state claims must not be fact-checked
  // against years-old cached pages — switch to news topic + a recent
  // window. Tier 2.5 widened the default window from 30 to 365 days after
  // dogfood showed 30 days excluded anchor events (the Nov 2024 election
  // was 18 months back from "today" 2026-04, outside the window, so the
  // verifier wrongly flagged "Trump won 2024" as false).
  it("defaults to topic=news + days=365 in Tavily body for time-sensitive claims", () => {
    const body = buildTavilyRequestBody("who won the 2024 election", "k", { timeSensitive: true });
    expect(body).toMatchObject({ query: "who won the 2024 election", topic: "news", days: 365 });
  });

  it("honors a custom timeSensitiveDays override on the Tavily body", () => {
    const body = buildTavilyRequestBody("S&P close yesterday", "k", {
      timeSensitive: true,
      timeSensitiveDays: 7
    });
    expect(body).toMatchObject({ topic: "news", days: 7 });
  });

  it("omits topic + days from Tavily body for stable historical claims", () => {
    const body = buildTavilyRequestBody("where is the Eiffel Tower", "k");
    expect(body.topic).toBeUndefined();
    expect(body.days).toBeUndefined();
    expect(body).toMatchObject({ query: "where is the Eiffel Tower", max_results: 3 });
  });

  // Tier 2.5: detection-time guard against partial-utterance claims. The
  // dogfood produced "The S&P 500 went up 1" because the transcript split
  // "1.7%" across a segment boundary — that truncated claim got published,
  // dedup then blocked the later complete "1.7%" version, and the user saw
  // a corrupted intervention. Drop claims that look mid-sentence so the
  // next window's complete version gets through.
  it("flags truncated claims ending with a quantifier + bare 1-3 digit number", () => {
    expect(looksTruncated("The S&P 500 went up 1")).toBe(true);
    expect(looksTruncated("It went up 1.")).toBe(true);
    expect(looksTruncated("The stock fell to 50")).toBe(true);
    expect(looksTruncated("Inflation is 8")).toBe(true);
  });

  it("does not flag complete claims as truncated", () => {
    // 4-digit years are not truncated (they're complete).
    expect(looksTruncated("Trump won in 2016")).toBe(false);
    // Decimals + units are complete.
    expect(looksTruncated("The S&P 500 went up 1.7%")).toBe(false);
    expect(looksTruncated("It went up 0.5%")).toBe(false);
    // Counts that don't end with a bare digit are complete.
    expect(looksTruncated("Joe Biden received 306 electoral votes")).toBe(false);
    // Stable factual statements are complete.
    expect(looksTruncated("The Eiffel Tower is in Paris")).toBe(false);
  });

  // Tier 2.6: fragment-claim filter. Dogfood produced "1.7%." as a standalone
  // claim when the LLM picked a bare percentage out of a multi-segment window
  // — verifier had no subject to fact-check and emitted a nonsensical
  // correction. Require ≥ 2 alphabetic word tokens.
  it("flags subject-less number/percentage fragments as not-a-claim", () => {
    expect(isFragmentClaim("1.7%.")).toBe(true);
    expect(isFragmentClaim("0.8%")).toBe(true);
    expect(isFragmentClaim("306")).toBe(true);
    expect(isFragmentClaim("S&P 500")).toBe(true); // only "S" and "P" — single letters
    expect(isFragmentClaim(".")).toBe(true);
  });

  it("keeps real claims with at least subject + verb", () => {
    expect(isFragmentClaim("S&P went up")).toBe(false);
    expect(isFragmentClaim("Trump won in 2024")).toBe(false);
    expect(isFragmentClaim("The S&P 500 went up 1.7%")).toBe(false);
    expect(isFragmentClaim("The iPhone 17 was released")).toBe(false);
    expect(isFragmentClaim("The Eiffel Tower is in Paris")).toBe(false);
  });

  it("defaults timeSensitive to false on a deserialized claim assessment", () => {
    const parsed = claimAssessmentSchema.parse({
      claimId: "claim_1",
      sessionId: "session_1",
      mode: "debate_live",
      transcriptSegmentIds: ["segment_1"],
      claimText: "The Eiffel Tower is in Paris.",
      query: "Eiffel Tower location",
      isVerifiable: true,
      confidence: 0.9,
      rationale: "Stable geographic fact.",
      speakerRole: "self"
    });

    expect(parsed.timeSensitive).toBe(false);
  });

  it("preserves timeSensitive=true when the detector flagged it", () => {
    const parsed = claimAssessmentSchema.parse({
      claimId: "claim_2",
      sessionId: "session_1",
      mode: "debate_live",
      transcriptSegmentIds: ["segment_1"],
      claimText: "The S&P closed at an all-time high yesterday.",
      query: "S&P 500 close yesterday",
      isVerifiable: true,
      confidence: 0.85,
      rationale: "Recent market state.",
      speakerRole: "opponent",
      timeSensitive: true
    });

    expect(parsed.timeSensitive).toBe(true);
  });

  // Tier 4: opinion verdicts use a separate gate from fact verdicts. They
  // don't go through Tavily / the verifier, so the "confidence" we see is
  // detection confidence — the LLM's certainty that the utterance was
  // subjective. We use a 0.6 floor for opponents and a 0.7 floor for self
  // (existing asymmetric +0.10 nudge so we don't over-flag the user's own
  // opinions).
  it("publishes opinion notifications when detection confidence is high enough", () => {
    expect(shouldPublishNotification({
      claimId: "claim_1",
      sessionId: "session_1",
      transcriptSegmentIds: ["segment_1"],
      claimText: "Trump is the best president ever.",
      verdict: "opinion",
      confidence: 0.85,
      correction: "That sounded like an opinion — backing it with evidence would make it more persuasive.",
      sources: [],
      checkedAt: "2026-04-27T12:00:00.000Z",
      speakerRole: "opponent"
    }, 0.75)).toBe(true);
  });

  it("drops low-confidence opinion detections", () => {
    expect(shouldPublishNotification({
      claimId: "claim_1",
      sessionId: "session_1",
      transcriptSegmentIds: ["segment_1"],
      claimText: "It might be a good movie.",
      verdict: "opinion",
      confidence: 0.4,
      correction: "That sounded like an opinion.",
      sources: [],
      checkedAt: "2026-04-27T12:00:00.000Z",
      speakerRole: "opponent"
    }, 0.75)).toBe(false);
  });

  it("applies asymmetric self bump to opinions too", () => {
    const baseAssessment = {
      claimId: "claim_1",
      sessionId: "session_1",
      transcriptSegmentIds: ["segment_1"],
      claimText: "AI is dangerous.",
      verdict: "opinion" as const,
      correction: "That sounded like an opinion.",
      sources: [],
      checkedAt: "2026-04-27T12:00:00.000Z"
    };
    expect(shouldPublishNotification({
      ...baseAssessment,
      confidence: 0.65,
      speakerRole: "self" as const
    }, 0.75)).toBe(false);
    expect(shouldPublishNotification({
      ...baseAssessment,
      confidence: 0.65,
      speakerRole: "opponent" as const
    }, 0.75)).toBe(true);
  });

  it("defaults claimType to 'fact' on a deserialized assessment", () => {
    const parsed = claimAssessmentSchema.parse({
      claimId: "claim_1",
      sessionId: "session_1",
      mode: "debate_live",
      transcriptSegmentIds: ["segment_1"],
      claimText: "The Eiffel Tower is in Paris.",
      query: "Eiffel Tower location",
      isVerifiable: true,
      confidence: 0.9,
      rationale: "Stable fact.",
      speakerRole: "self"
    });
    expect(parsed.claimType).toBe("fact");
  });

  it("preserves claimType='opinion' through schema parse", () => {
    const parsed = claimAssessmentSchema.parse({
      claimId: "claim_3",
      sessionId: "session_1",
      mode: "debate_live",
      transcriptSegmentIds: ["segment_1"],
      claimText: "Trump is the best president ever.",
      query: "Trump best president",
      isVerifiable: false,
      confidence: 0.85,
      rationale: "Forceful value judgment.",
      speakerRole: "opponent",
      claimType: "opinion"
    });
    expect(parsed.claimType).toBe("opinion");
  });

  // Tier 4 (2/3): profanity detector. Deterministic regex pre-check that
  // runs on each segment before LLM detection. Word boundaries prevent
  // false hits on substrings like "Scunthorpe" or "class".
  it("detects strong language hits", () => {
    expect(detectProfanity("That's fucking insane").found).toBe(true);
    expect(detectProfanity("What a piece of shit policy").found).toBe(true);
    expect(detectProfanity("Don't be such an asshole about it").found).toBe(true);
    expect(detectProfanity("That's bullshit and you know it").found).toBe(true);
  });

  it("returns the matched word for observability", () => {
    const hit = detectProfanity("That's a load of bullshit");
    expect(hit.found).toBe(true);
    expect(hit.word).toBe("bullshit");
  });

  it("does not match polite text", () => {
    expect(detectProfanity("The S&P went up 1.7% yesterday").found).toBe(false);
    expect(detectProfanity("Trump won the 2024 election decisively").found).toBe(false);
    expect(detectProfanity("That's an interesting point about the economy").found).toBe(false);
  });

  it("ignores substring false positives via word boundaries", () => {
    // "Scunthorpe" contains "cunt" as a substring but should not match.
    expect(detectProfanity("I went to Scunthorpe last summer").found).toBe(false);
    // "class" contains "ass" as a substring.
    expect(detectProfanity("She teaches a great economics class").found).toBe(false);
    // "shittake" — not a real word but tests the boundary.
    expect(detectProfanity("Mushroom variety classification").found).toBe(false);
  });

  it("publishes profanity notifications regardless of speaker role", () => {
    const baseAssessment = {
      claimId: "claim_p",
      sessionId: "session_1",
      transcriptSegmentIds: ["segment_1"],
      claimText: "That's bullshit",
      verdict: "profanity" as const,
      confidence: 0.95,
      correction: "That's intense — can you back it up with evidence?",
      sources: [],
      checkedAt: "2026-04-27T12:00:00.000Z"
    };
    expect(shouldPublishNotification({
      ...baseAssessment,
      speakerRole: "self" as const
    }, 0.75)).toBe(true);
    expect(shouldPublishNotification({
      ...baseAssessment,
      speakerRole: "opponent" as const
    }, 0.75)).toBe(true);
  });
});
