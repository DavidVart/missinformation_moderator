import { PromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import type { ClaimAssessment, ClaimVerificationResult, SourceCitation, TranscriptSegment } from "@project-veritas/contracts";
import { claimAssessmentSchema, claimVerificationResultSchema, sourceCitationSchema } from "@project-veritas/contracts";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const detectedClaimSchema = z.object({
  isVerifiable: z.boolean(),
  claimText: z.string(),
  query: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  // V2: which speaker actually made this claim. The prompt tags every line
  // with [SELF] or [OPPONENT]; the model returns whichever speaker's line the
  // claim was drawn from (or "unknown" if ambiguous).
  speakerRole: z.enum(["self", "opponent", "unknown"]).default("unknown"),
  // Tier 2: when true, the claim's truth depends on recent state
  // (election outcomes, current prices, sports scores, latest poll, etc.).
  // The verifier consumer biases Tavily search to the last 30 days for
  // these so we don't fact-check a 2024 claim against 2019 cached pages.
  timeSensitive: z.boolean().default(false)
});

/**
 * Tier 1.5: multi-claim detection. The LLM now returns ALL distinct
 * verifiable claims it sees in the window, not just the most prominent
 * one. Previous "single claim per assessment" behaviour caused rapid-fire
 * sessions ("Trump won in 2014, 2028, 2020, 2027 …") to publish only
 * one correction because the LLM read the others as "repeated
 * restatements" of the dominant claim.
 */
const claimDetectionSchema = z.object({
  claims: z.array(detectedClaimSchema)
});

const verificationSchema = z.object({
  verdict: z.enum(["true", "false", "misleading", "unverified"]),
  confidence: z.number().min(0).max(1),
  correction: z.string()
});

export type ReasoningEngine = {
  /**
   * Returns ALL distinct verifiable claims the LLM detected in the transcript
   * window. May be an empty array when nothing is verifiable. The
   * detection consumer dedupes each claim independently before publishing.
   */
  assessWindow: (sessionId: string, transcriptWindow: TranscriptSegment[]) => Promise<ClaimAssessment[]>;
  verifyClaim: (assessment: ClaimAssessment, citations: SourceCitation[]) => Promise<ClaimVerificationResult>;
};

type TavilyResult = {
  title: string;
  url: string;
  content: string;
  published_date?: string | undefined;
};

const CLAIM_FILLER_TOKENS = new Set([
  "actually",
  "basically",
  "honestly",
  "just",
  "kind",
  "kinda",
  "like",
  "literally",
  "maybe",
  "really",
  "simply",
  "sorta",
  "sort",
  "well"
]);

const CLAIM_STOP_TOKENS = new Set([
  "a",
  "an",
  "any",
  "the"
]);

const TRUSTED_HOST_PATTERNS = [
  /\.gov$/i,
  /\.edu$/i,
  /(^|\.)reuters\.com$/i,
  /(^|\.)apnews\.com$/i,
  /(^|\.)bbc\.(com|co\.uk)$/i,
  /(^|\.)npr\.org$/i,
  /(^|\.)who\.int$/i,
  /(^|\.)europa\.eu$/i,
  /(^|\.)ecb\.europa\.eu$/i,
  /(^|\.)imf\.org$/i,
  /(^|\.)worldbank\.org$/i,
  /(^|\.)oecd\.org$/i,
  /(^|\.)britannica\.com$/i
];

const LOW_SIGNAL_HOST_PATTERNS = [
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)yelp\.com$/i,
  /(^|\.)tripadvisor\./i,
  /(^|\.)pinterest\./i,
  /(^|\.)linkedin\.com$/i
];

function normalizeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function tokenizeText(text: string) {
  // Protect decimal numbers (1.7, 3.2, 0.05) before splitting so the dot
  // doesn't break them into single digits that get filtered out by the
  // length check. Without this, "1.7 percent" and "3.2 percent" canonicalize
  // identically and dedup collapses two distinct percentage claims into one.
  return text
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, "$1_$2")
    .split(/[^a-z0-9_]+/i)
    .map((token) => token.replace(/_/g, ".").trim())
    .filter((token) => token.length >= 3);
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function hasTerminalPunctuation(text: string) {
  const trimmed = text.trim();
  return /[!?]["')\]]*$/.test(trimmed) || /(?<!\.)\.(?!\.)["')\]]*$/.test(trimmed);
}

/**
 * Detection-time guard against partial-utterance claims like "The S&P 500
 * went up 1" — a transcript fragment where the speaker had said "1.7%" but
 * the next segment with the decimal hadn't arrived yet. Without this filter
 * the truncated version gets published, the dedup blocks the later complete
 * "1.7%" version, and the user sees a corrupted intervention.
 *
 * Heuristic: claim ends with a quantifier word ("up", "down", "to", "by",
 * "is", "was", etc.) followed by a 1–3 digit bare number with optional
 * trailing dot, no `%`, no decimal, no unit. Year numbers (4 digits) and
 * counts with units survive.
 */
export function looksTruncated(text: string): boolean {
  const trimmed = text.trim();
  return /\b(up|down|to|by|at|of|over|under|about|near|is|was|were|are)\s+\d{1,3}\.?$/i.test(trimmed);
}

function overlapCount(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.reduce((count, token) => count + (rightSet.has(token) ? 1 : 0), 0);
}

function isTrustedHost(host: string) {
  return TRUSTED_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function isLowSignalHost(host: string) {
  return LOW_SIGNAL_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

type RankedCitation = {
  citation: SourceCitation;
  host: string;
  score: number;
  lowSignal: boolean;
};

export function rankCitation(citation: SourceCitation, query: string): RankedCitation {
  const host = normalizeHost(citation.url);
  const queryTokens = tokenizeText(query);
  const titleTokens = tokenizeText(citation.title);
  const snippetTokens = tokenizeText(citation.snippet);
  const titleOverlap = overlapCount(queryTokens, titleTokens);
  const snippetOverlap = overlapCount(queryTokens, snippetTokens);
  const lowSignal = isLowSignalHost(host);

  let score = 0;

  if (isTrustedHost(host)) {
    score += 60;
  }

  if (host.endsWith(".gov") || host.endsWith(".edu")) {
    score += 15;
  }

  if (citation.publishedAt) {
    score += 6;
  }

  score += titleOverlap * 10;
  score += snippetOverlap * 3;

  if (lowSignal) {
    score -= 45;
  }

  return {
    citation,
    host,
    score,
    lowSignal
  };
}

export function curateCitations(citations: SourceCitation[], query: string, limit = 4) {
  const deduped = new Map<string, SourceCitation>();

  for (const citation of citations) {
    const host = normalizeHost(citation.url);
    const dedupeKey = `${host}|${citation.title.trim().toLowerCase()}`;
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, citation);
    }
  }

  const ranked = [...deduped.values()]
    .map((citation) => rankCitation(citation, query))
    .sort((left, right) => right.score - left.score);

  const preferred = ranked.filter((entry) => !entry.lowSignal);
  const pool = preferred.length > 0 ? preferred : ranked;

  return pool.slice(0, limit).map((entry) => sourceCitationSchema.parse(entry.citation));
}

export function canonicalizeClaimText(text: string) {
  const canonicalTokens = tokenizeText(text).filter(
    (token) => !CLAIM_FILLER_TOKENS.has(token) && !CLAIM_STOP_TOKENS.has(token)
  );

  return canonicalTokens.join(" ");
}

export function claimIdentityKey(text: string) {
  return canonicalizeClaimText(text) || normalizeWhitespace(text).toLowerCase();
}

/**
 * A token is "distinguishing" if it's a number or a capitalized word in the
 * original (pre-canonicalization) claim. Two claims that share all their
 * filler words but differ on a single year / percentage / proper noun are NOT
 * duplicates, so we require at least one shared distinguishing token.
 */
function extractDistinguishingTokens(rawText: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of rawText.split(/\s+/)) {
    const trimmed = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!trimmed) continue;
    // Numbers (years, percents, counts)
    if (/\d/.test(trimmed)) {
      tokens.add(trimmed.toLowerCase());
      continue;
    }
    // Proper nouns — starts with uppercase, length ≥ 3, not a sentence starter
    // we can't easily distinguish. Erring on the side of inclusion is fine
    // since we only use these as a "shared distinguisher" check.
    if (/^[A-Z]/.test(trimmed) && trimmed.length >= 3) {
      tokens.add(trimmed.toLowerCase());
    }
  }
  return tokens;
}

export function claimsAreEquivalent(left: string, right: string) {
  const leftIdentity = claimIdentityKey(left);
  const rightIdentity = claimIdentityKey(right);

  if (!leftIdentity || !rightIdentity) {
    return false;
  }

  if (leftIdentity === rightIdentity) {
    return true;
  }

  // Substring containment means one claim is fully the other → still a dup.
  if (leftIdentity.includes(rightIdentity) || rightIdentity.includes(leftIdentity)) {
    return true;
  }

  const leftTokens = leftIdentity.split(" ").filter(Boolean);
  const rightTokens = rightIdentity.split(" ").filter(Boolean);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false;
  }

  const sharedTokenCount = overlapCount(leftTokens, rightTokens);
  const shorterLength = Math.min(leftTokens.length, rightTokens.length);
  const longerLength = Math.max(leftTokens.length, rightTokens.length);

  // Tier 1: tightened thresholds. Previous values (0.8 / 0.67) merged distinct
  // claims that happened to share many filler/common words — e.g.
  // "Trump won the 2016 election" vs "Trump won the 2024 election" shared 4 of
  // 5 tokens → 0.8 → incorrectly deduplicated. Now require ≥0.9 on the shorter
  // side OR ≥0.85 on the longer side, AND require at least one shared
  // "distinguishing" token (number or capitalized word). Two claims that
  // differ on the one number or proper noun that matters are no longer
  // treated as duplicates.
  const highOverlap =
    sharedTokenCount >= 4 &&
    (sharedTokenCount / shorterLength >= 0.9 || sharedTokenCount / longerLength >= 0.85);

  if (!highOverlap) {
    return false;
  }

  const leftDistinguishers = extractDistinguishingTokens(left);
  const rightDistinguishers = extractDistinguishingTokens(right);

  // If neither claim has any distinguishers, fall back to overlap alone
  // (claims without numbers/proper nouns are typically short opinions/fillers
  // that shouldn't reach the dedup path anyway).
  if (leftDistinguishers.size === 0 && rightDistinguishers.size === 0) {
    return true;
  }

  for (const token of leftDistinguishers) {
    if (rightDistinguishers.has(token)) {
      return true;
    }
  }

  // Both have distinguishing tokens but none shared → different facts.
  return false;
}

const DEFAULT_WINDOW_SIZE = 5;
const DEFAULT_WINDOW_MIN_TOTAL_LENGTH = 16;

export function buildWindowSignature(segments: TranscriptSegment[], windowSize = DEFAULT_WINDOW_SIZE) {
  return normalizeWhitespace(
    segments
      .sort((left, right) => left.seq - right.seq)
      .slice(-windowSize)
      .map((segment) => segment.text)
      .join(" ")
  ).toLowerCase();
}

export function shouldAssessWindow(
  segments: TranscriptSegment[],
  previousSignature?: string | null,
  options?: { minTotalLength?: number; windowSize?: number }
) {
  const windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
  const minTotalLength = options?.minTotalLength ?? DEFAULT_WINDOW_MIN_TOTAL_LENGTH;

  const orderedWindow = segments
    .sort((left, right) => left.seq - right.seq)
    .slice(-windowSize);

  const latestSegment = orderedWindow.at(-1);
  if (!latestSegment) {
    return false;
  }

  const signature = buildWindowSignature(orderedWindow, windowSize);
  if (!signature || signature === previousSignature) {
    return false;
  }

  const latestText = normalizeWhitespace(latestSegment.text);
  const totalLength = signature.length;
  const latestTokenCount = tokenizeText(latestText).length;

  // Tier 1: reduced minimums so claims split across short segments
  // (e.g. "The United States isn't..." / "a country in North..." / "America.")
  // aren't gated out when each piece is short. The LLM sees the whole
  // N-segment window either way.
  if (totalLength < minTotalLength || latestText.length < 4) {
    return false;
  }

  if (hasTerminalPunctuation(latestText)) {
    return true;
  }

  // Trigger when either: (a) the final segment alone is meaningful (≥4
  // tokens, was ≥5 — loosened slightly), or (b) the whole window has
  // enough content to analyze (≥48 chars, was ≥72). The 4-token floor
  // keeps fillers like "he actually like..." from triggering on their
  // own; their slow-claim partners arrive via the punctuation path.
  return latestTokenCount >= 4 || totalLength >= 48;
}

export function createReasoningEngine(config: {
  openAiApiKey?: string | undefined;
  openAiModel: string;
  tavilyApiKey?: string | undefined;
}): ReasoningEngine {
  if (!config.openAiApiKey || !config.tavilyApiKey) {
    return createMockReasoningEngine();
  }

  const claimPrompt = PromptTemplate.fromTemplate(
    `You are a factual claim detector for a two-person debate fact-checker. Today's date is {currentDate}.\n` +
      `Review the transcript and identify EVERY distinct verifiable factual claim it contains.\n` +
      `Each line is prefixed with the speaker role ([SELF] or [OPPONENT]).\n` +
      `Return one entry in the "claims" array for EACH separate factual assertion. If the speaker\n` +
      `lists multiple distinct facts (e.g. "Trump won in 2014 and 2028 and 2020"), return a separate\n` +
      `claim for each year/entity — they are independent facts and must each be verified separately.\n` +
      `If the same claim is repeated verbatim multiple times in the window, include it only once.\n` +
      `Ignore filler words and partial fragments.\n` +
      `Do NOT flag clear opinions ("I think...", "I believe...", "In my view..."), rhetorical questions,\n` +
      `or hypotheticals. Focus on verifiable assertions of fact — names, dates, numbers, events, causal claims.\n` +
      `If the claim is attributed to [SELF], apply stricter scrutiny — only flag objectively verifiable statements,\n` +
      `never personal opinions or first-person anecdotes.\n` +
      `CRITICAL: populate the speakerRole field on each claim with the tag of the line the claim was drawn from —\n` +
      `"self" if the claim appears on a [SELF] line, "opponent" if it appears on an [OPPONENT] line.\n` +
      `If a claim spans both speakers or is ambiguous, set its speakerRole to "unknown".\n` +
      `Set timeSensitive=true when the claim's truth depends on recent state — e.g. current election results,\n` +
      `live stock or crypto prices, ongoing sports scores, the latest poll, breaking news from the past few weeks,\n` +
      `or anything phrased with "this year", "last week", "right now", "currently". For stable historical or\n` +
      `geographical facts (the Eiffel Tower's location, who won WWII, the speed of light), leave it false.\n` +
      `If the transcript contains no verifiable factual claims at all, return an empty "claims" array.\n` +
      `Respond only using the requested structured schema.\n\nTranscript:\n{transcript}`
  );

  const verifyPrompt = PromptTemplate.fromTemplate(
    `You are a fact verifier. Today's date is {currentDate}.\n` +
      `Use only the supplied evidence to decide whether the claim is true, false, misleading, or unverifiable.\n` +
      `When the claim is paraphrasing a real fact with rounded numbers, judge it true within sensible tolerance —\n` +
      `±5 percentage points for percentage claims, ±10% for raw counts/quantities, ±1 year when the claim\n` +
      `gives a round year for an event. Only mark "false" or "misleading" when the claim is wrong beyond those\n` +
      `tolerances or when it asserts the wrong entity, place, or causal direction.\n` +
      `CRITICAL for time-sensitive claims (current president, recent election outcomes, ongoing prices, latest\n` +
      `polls, this-year/this-week claims): if the most recent dated evidence contradicts your training-cutoff\n` +
      `intuition, TRUST THE EVIDENCE. The world changes after model training; today's date is {currentDate} and\n` +
      `the dated evidence is authoritative. Do not return "false" against fresh evidence just because your\n` +
      `internal knowledge says otherwise — your knowledge may be stale.\n` +
      `If the claim is about ongoing or recent state ("current", "this year", "right now"), prefer the most\n` +
      `recent dated evidence; treat older sources as historical context only.\n` +
      `If the claim is false or misleading, return a direct correction in at most two short sentences.\n` +
      `Lead with the corrected fact. Avoid long background paragraphs, process commentary, or extra speculation.\n\nClaim:\n{claim}\n\nEvidence:\n{evidence}`
  );

  const llm = new ChatOpenAI({
    apiKey: config.openAiApiKey,
    model: config.openAiModel,
    temperature: 0
  });

  const claimChain = claimPrompt.pipe(llm.withStructuredOutput(claimDetectionSchema));
  const verifyChain = verifyPrompt.pipe(llm.withStructuredOutput(verificationSchema));

  return {
    async assessWindow(sessionId, transcriptWindow) {
      // V2: include speaker role in each line so the LLM can apply asymmetric
      // scrutiny (strict for SELF, normal for OPPONENT).
      const transcriptText = transcriptWindow
        .map((segment) => {
          const role = (segment.speakerRole ?? "unknown").toUpperCase();
          return `[${role}] ${segment.text}`;
        })
        .join("\n");

      const result = await claimChain.invoke({
        transcript: transcriptText,
        currentDate: todayIso()
      });

      const candidates = (result.claims ?? []).filter(
        (claim) =>
          claim.isVerifiable &&
          claim.claimText.trim().length > 0 &&
          !looksTruncated(claim.claimText)
      );

      if (candidates.length === 0) {
        return [];
      }

      // Pre-compute word share so we can fall back deterministically when the
      // LLM returns "unknown" speakerRole on any individual claim.
      const wordsByRole = { self: 0, opponent: 0 };
      for (const segment of transcriptWindow) {
        const role = segment.speakerRole;
        if (role === "self") wordsByRole.self += segment.text.split(/\s+/).length;
        else if (role === "opponent") wordsByRole.opponent += segment.text.split(/\s+/).length;
      }
      const fallbackRole: "self" | "opponent" | "unknown" =
        wordsByRole.self === wordsByRole.opponent
          ? ((transcriptWindow.at(-1)?.speakerRole ?? "unknown") as "self" | "opponent" | "unknown")
          : wordsByRole.self > wordsByRole.opponent
            ? "self"
            : "opponent";

      const assessments: ClaimAssessment[] = [];
      for (const claim of candidates) {
        const speakerRole: "self" | "opponent" | "unknown" =
          claim.speakerRole && claim.speakerRole !== "unknown" ? claim.speakerRole : fallbackRole;

        assessments.push(
          claimAssessmentSchema.parse({
            claimId: uuidv4(),
            sessionId,
            userId: transcriptWindow.find((segment) => segment.userId)?.userId,
            mode: transcriptWindow.at(-1)?.mode ?? "debate_live",
            transcriptSegmentIds: transcriptWindow.map((segment) => segment.segmentId),
            claimText: claim.claimText,
            query: claim.query || claim.claimText,
            isVerifiable: claim.isVerifiable,
            confidence: claim.confidence,
            rationale: claim.rationale,
            speakerRole,
            timeSensitive: claim.timeSensitive ?? false
          })
        );
      }

      return assessments;
    },
    async verifyClaim(assessment, citations) {
      const evidence = citations
        .map((citation, index) => `${index + 1}. ${citation.title}\n${citation.snippet}\n${citation.url}`)
        .join("\n\n");

      const result = await verifyChain.invoke({
        claim: assessment.claimText,
        evidence,
        currentDate: todayIso()
      });

      return claimVerificationResultSchema.parse({
        claimId: assessment.claimId,
        sessionId: assessment.sessionId,
        userId: assessment.userId,
        mode: assessment.mode,
        transcriptSegmentIds: assessment.transcriptSegmentIds,
        claimText: assessment.claimText,
        verdict: result.verdict,
        confidence: result.confidence,
        correction: result.correction,
        sources: citations.map((citation) => sourceCitationSchema.parse(citation)),
        checkedAt: new Date().toISOString(),
        speakerRole: assessment.speakerRole ?? "unknown"
      });
    }
  };
}

function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type TavilySearchOptions = {
  timeSensitive?: boolean;
  /**
   * How far back to search when timeSensitive is true. The original 30-day
   * default missed anchor events sitting just outside the window — e.g.
   * verifying "current president" in 2026-04 against news ≥ 30 days old
   * meant the inauguration / election-result articles never showed up,
   * the LLM fell back on training-cutoff intuition, and returned wrong
   * verdicts. 365 days catches the full term + result coverage. Wire as
   * env-configurable so we can tune later if hyper-recent claims (live
   * scores, today's prices) need a narrower window.
   */
  timeSensitiveDays?: number;
};

const DEFAULT_TIME_SENSITIVE_DAYS = 365;

export function buildTavilyRequestBody(
  query: string,
  apiKey: string,
  options: TavilySearchOptions = {}
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: 3,
    include_answer: false,
    search_depth: "basic"
  };
  if (options.timeSensitive) {
    // Tavily's `days` filter only applies when topic is "news"; switching
    // topic biases ranking toward recent reporting too, which is what we
    // want for election results / live stats / current events.
    body.topic = "news";
    body.days = options.timeSensitiveDays ?? DEFAULT_TIME_SENSITIVE_DAYS;
  }
  return body;
}

async function searchTavily(
  query: string,
  apiKey: string,
  options: TavilySearchOptions = {}
): Promise<SourceCitation[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(buildTavilyRequestBody(query, apiKey, options))
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed with status ${response.status}`);
  }

  const payload = z.object({
    results: z.array(z.object({
      title: z.string(),
      url: z.string().url(),
      content: z.string(),
      published_date: z.string().optional()
    }))
  }).parse(await response.json());

  return payload.results.map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.content,
    publishedAt: result.published_date,
    sourceType: "web" as const
  }));
}

function countHighSignalCitations(citations: SourceCitation[]) {
  return citations.filter((citation) => !isLowSignalHost(normalizeHost(citation.url))).length;
}

function createMockReasoningEngine(): ReasoningEngine {
  return {
    async assessWindow(sessionId, transcriptWindow) {
      const transcriptText = transcriptWindow.map((segment) => segment.text).join(" ");
      if (!/\bis\b|\bare\b|\bwas\b|\bwere\b/i.test(transcriptText)) {
        return [];
      }

      const claimText = transcriptText.split(/[.?!]/)[0]?.trim() ?? transcriptText.trim();
      if (!claimText) {
        return [];
      }

      return [
        {
          claimId: uuidv4(),
          sessionId,
          userId: transcriptWindow.find((segment) => segment.userId)?.userId,
          mode: transcriptWindow.at(-1)?.mode ?? "debate_live",
          transcriptSegmentIds: transcriptWindow.map((segment) => segment.segmentId),
          claimText,
          query: claimText,
          isVerifiable: true,
          confidence: 0.77,
          rationale: "Heuristic mock detector found a declarative factual statement.",
          speakerRole: transcriptWindow.at(-1)?.speakerRole ?? "unknown",
          timeSensitive: false
        }
      ];
    },
    async verifyClaim(assessment) {
      const normalized = assessment.claimText.toLowerCase();
      const obviouslyFalse =
        normalized.includes("eiffel tower is in berlin") ||
        normalized.includes("earth is flat");

      return {
        claimId: assessment.claimId,
        sessionId: assessment.sessionId,
        userId: assessment.userId,
        mode: assessment.mode,
        transcriptSegmentIds: assessment.transcriptSegmentIds,
        claimText: assessment.claimText,
        verdict: obviouslyFalse ? "false" : "unverified",
        confidence: obviouslyFalse ? 0.92 : 0.5,
        correction: obviouslyFalse
          ? "That claim is incorrect. The Eiffel Tower is in Paris, and the Earth is an oblate spheroid."
          : "The claim could not be verified in mock mode.",
        sources: [],
        checkedAt: new Date().toISOString(),
        speakerRole: assessment.speakerRole ?? "unknown"
      };
    }
  };
}

export async function fetchCitations(
  query: string,
  tavilyApiKey?: string,
  options: TavilySearchOptions = {}
) {
  if (!tavilyApiKey) {
    return [] satisfies SourceCitation[];
  }

  const primaryResults = await searchTavily(query, tavilyApiKey, options);

  if (countHighSignalCitations(primaryResults) >= 1) {
    return curateCitations(primaryResults, query);
  }

  // Single fallback search instead of two parallel ones (saves 1 Tavily credit per claim)
  try {
    const fallbackResults = await searchTavily(`${query} official source`, tavilyApiKey, options);
    return curateCitations([...primaryResults, ...fallbackResults], query);
  } catch {
    return curateCitations(primaryResults, query);
  }
}

export function buildRollingWindow(segments: TranscriptSegment[], windowSize = DEFAULT_WINDOW_SIZE) {
  return segments
    .sort((left, right) => left.seq - right.seq)
    .slice(-windowSize);
}

export function shouldIntervene(result: ClaimVerificationResult, threshold: number) {
  return ["false", "misleading"].includes(result.verdict) && result.confidence >= threshold;
}
