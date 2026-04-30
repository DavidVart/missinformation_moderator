import { describe, expect, it } from "vitest";

import { claimAssessmentSchema } from "@project-veritas/contracts";

import { shouldPublishNotification } from "../src/notification.js";
import {
  buildDetectionFailureSentryExtra,
  buildRollingWindow,
  buildSoftVerification,
  buildTavilyRequestBody,
  canonicalizeClaimText,
  claimsAreEquivalent,
  curateCitations,
  detectProfanity,
  isFragmentClaim,
  looksTruncated,
  redactClaimText,
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

  // Tier 4 short-circuit: opinion / profanity skip Tavily + verifier and a
  // synthetic ClaimVerificationResult is built from the assessment. These
  // tests pin the verdict mapping, correction text, and field passthrough so
  // future refactors can't silently break the soft-prompt UI contract.
  function softAssessment(claimType: "opinion" | "profanity" | "fact" | "hate") {
    return claimAssessmentSchema.parse({
      claimId: "claim_s",
      sessionId: "session_42",
      userId: "user_7",
      mode: "debate_live",
      transcriptSegmentIds: ["seg_1", "seg_2"],
      claimText: "That's just my view",
      query: "That's just my view",
      isVerifiable: false,
      confidence: 0.82,
      rationale: "subjective",
      speakerRole: "opponent",
      timeSensitive: false,
      claimType
    });
  }

  it("buildSoftVerification maps opinion claimType to verdict='opinion' with the back-it-up nudge", () => {
    const result = buildSoftVerification(softAssessment("opinion"), {
      topic: "ai-policy",
      checkedAt: "2026-04-27T12:00:00.000Z"
    });
    expect(result.verdict).toBe("opinion");
    expect(result.correction).toContain("opinion");
    expect(result.correction).toContain("evidence");
    expect(result.sources).toEqual([]);
    expect(result.topic).toBe("ai-policy");
    expect(result.checkedAt).toBe("2026-04-27T12:00:00.000Z");
  });

  it("buildSoftVerification maps profanity claimType to verdict='profanity' with the back-it-up nudge", () => {
    const result = buildSoftVerification(softAssessment("profanity"), {
      topic: "general",
      checkedAt: "2026-04-27T12:00:00.000Z"
    });
    expect(result.verdict).toBe("profanity");
    expect(result.correction).toContain("intense");
    expect(result.correction).toContain("back it up");
    expect(result.sources).toEqual([]);
    expect(result.topic).toBe("general");
  });

  it("buildSoftVerification copies through identity and routing fields from the assessment", () => {
    const assessment = softAssessment("opinion");
    const result = buildSoftVerification(assessment, { topic: "general", checkedAt: "2026-04-27T12:00:00.000Z" });
    expect(result.claimId).toBe(assessment.claimId);
    expect(result.sessionId).toBe(assessment.sessionId);
    expect(result.userId).toBe(assessment.userId);
    expect(result.mode).toBe(assessment.mode);
    expect(result.transcriptSegmentIds).toEqual(assessment.transcriptSegmentIds);
    expect(result.claimText).toBe(assessment.claimText);
    expect(result.confidence).toBe(assessment.confidence);
    expect(result.speakerRole).toBe(assessment.speakerRole);
  });

  it("buildSoftVerification refuses fact claimType — short-circuit must not be reached for fact-checkable claims", () => {
    expect(() =>
      buildSoftVerification(softAssessment("fact"), { topic: "general", checkedAt: "2026-04-27T12:00:00.000Z" })
    ).toThrow(/opinion, profanity, or hate/);
  });

  // ─────────── Tier 4+: hate speech detection ───────────

  it("buildSoftVerification maps hate claimType to verdict='hate' with the dehumanizing-language nudge", () => {
    const result = buildSoftVerification(softAssessment("hate"), {
      topic: "political extremism",
      checkedAt: "2026-04-28T12:00:00.000Z"
    });
    expect(result.verdict).toBe("hate");
    expect(result.correction).toContain("dehumanizing");
    expect(result.correction).toContain("group");
    expect(result.sources).toEqual([]);
    expect(result.topic).toBe("political extremism");
    expect(result.checkedAt).toBe("2026-04-28T12:00:00.000Z");
  });

  it("shouldPublishNotification gates hate at the 0.7 floor (opponent), 0.8 (self)", () => {
    const baseAssessment = {
      claimId: "claim_h",
      sessionId: "session_h",
      transcriptSegmentIds: ["seg_h"],
      claimText: "[redacted-test-input]",
      verdict: "hate" as const,
      correction: "That sounded like dehumanizing language directed at a group — please reconsider.",
      sources: [],
      checkedAt: "2026-04-28T12:00:00.000Z"
    };
    // Opponent: 0.65 below floor (drops), 0.75 above (publishes)
    expect(shouldPublishNotification({
      ...baseAssessment,
      confidence: 0.65,
      speakerRole: "opponent" as const
    }, 0.75)).toBe(false);
    expect(shouldPublishNotification({
      ...baseAssessment,
      confidence: 0.75,
      speakerRole: "opponent" as const
    }, 0.75)).toBe(true);
    // Self: floor is bumped to 0.8 — 0.75 drops, 0.85 passes (caps at 0.85)
    expect(shouldPublishNotification({
      ...baseAssessment,
      confidence: 0.75,
      speakerRole: "self" as const
    }, 0.75)).toBe(false);
    expect(shouldPublishNotification({
      ...baseAssessment,
      confidence: 0.85,
      speakerRole: "self" as const
    }, 0.75)).toBe(true);
  });
});

// ─────────── Tier 4+: Sentry redaction for sensitive claim types ───────────

describe("redactClaimText", () => {
  it("returns a deterministic SHA-256 hash and a 3-word preview with ellipsis", () => {
    const result = redactClaimText("Communists don't deserve to live");
    // SHA-256 of the input, computed independently to anchor the test.
    expect(result.claimTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.claimTextPreview).toBe("Communists don't deserve…");
  });

  it("hashes deterministically — same input produces identical hash across calls", () => {
    const a = redactClaimText("That's bullshit");
    const b = redactClaimText("That's bullshit");
    expect(a.claimTextHash).toBe(b.claimTextHash);
    expect(a.claimTextPreview).toBe(b.claimTextPreview);
  });

  it("does not append ellipsis when the text is 3 words or fewer", () => {
    expect(redactClaimText("hi there").claimTextPreview).toBe("hi there");
    expect(redactClaimText("one two three").claimTextPreview).toBe("one two three");
  });

  it("appends ellipsis when the text is 4+ words", () => {
    expect(redactClaimText("one two three four").claimTextPreview).toBe("one two three…");
  });

  it("collapses repeated whitespace in the preview", () => {
    // 3-word preview from a string with weird spacing — words filtering should
    // discard the empty splits so the preview is clean.
    expect(redactClaimText("hello    world    again    extra").claimTextPreview).toBe("hello world again…");
  });

  it("buildDetectionFailureSentryExtra hashes both segment AND windowSignature, no raw user content escapes", () => {
    // The detection-phase catch in services/reasoning/src/index.ts fires when
    // gpt-4o-mini fails before classification — no claimType to gate on, so
    // unconditional redaction. windowSignature is NOT a hash — it's the
    // lowercased whitespace-normalized join of all rolling-window segments
    // (the user's full recent speech). Both segmentText and windowSignature
    // are redacted; windowChars (length) survives for triage signal, and the
    // 3-word preview survives for the latest-segment only.
    const segmentText = "Communists don't deserve to live and that's that";
    const windowSignature = "earlier filler and now communists don't deserve to live and that's that";
    const extra = buildDetectionFailureSentryExtra(segmentText, windowSignature);

    // windowSignature itself is hashed; the raw form does not appear.
    expect(extra.windowSignatureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(extra.windowChars).toBe(windowSignature.length);
    expect(extra.claimTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(extra.claimTextPreview).toBe("Communists don't deserve…");

    // No raw text under any of the legacy or alternate keys the prior
    // un-redacted version used.
    expect((extra as Record<string, unknown>).segmentText).toBeUndefined();
    expect((extra as Record<string, unknown>).text).toBeUndefined();
    expect((extra as Record<string, unknown>).claimText).toBeUndefined();
    expect((extra as Record<string, unknown>).windowSignature).toBeUndefined();

    // Defense-in-depth: the literal raw segment text and the literal raw
    // windowSignature must not appear as a value under any key, no matter
    // what we name it.
    for (const value of Object.values(extra)) {
      if (typeof value !== "string") continue;
      expect(value.includes(segmentText)).toBe(false);
      expect(value.includes(windowSignature)).toBe(false);
    }
  });

  it("buildDetectionFailureSentryExtra hashes the windowSignature deterministically across calls", () => {
    // Sentry uses identical extras to cluster repeat failures. Hash must be
    // stable for the same input — this is the point of using SHA-256 over a
    // random opaque ID.
    const a = buildDetectionFailureSentryExtra("seg", "the rolling window text");
    const b = buildDetectionFailureSentryExtra("seg", "the rolling window text");
    expect(a.windowSignatureHash).toBe(b.windowSignatureHash);
    // Different windows → different hashes (sanity, no collision in trivial case).
    const c = buildDetectionFailureSentryExtra("seg", "a different window");
    expect(c.windowSignatureHash).not.toBe(a.windowSignatureHash);
  });

  it("handles empty / whitespace-only input without throwing", () => {
    // Edge case: empty or all-whitespace input shouldn't crash. Hash is still
    // computed (sha256 of empty string is a real, deterministic hex digest)
    // and preview is empty. This shouldn't happen in practice (the regex
    // pre-check or the LLM gate would filter empty utterances earlier) but
    // we should never throw out of a Sentry path.
    expect(redactClaimText("").claimTextPreview).toBe("");
    expect(redactClaimText("").claimTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(redactClaimText("    ").claimTextPreview).toBe("");
  });
});
