import { PromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import type { ClaimAssessment, ClaimVerificationResult, SourceCitation, TranscriptSegment } from "@project-veritas/contracts";
import { claimAssessmentSchema, claimVerificationResultSchema, sourceCitationSchema } from "@project-veritas/contracts";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const claimDetectionSchema = z.object({
  isVerifiable: z.boolean(),
  claimText: z.string(),
  query: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  // V2: which speaker actually made this claim. The prompt tags every line
  // with [SELF] or [OPPONENT]; the model returns whichever speaker's line the
  // claim was drawn from (or "unknown" if ambiguous).
  speakerRole: z.enum(["self", "opponent", "unknown"]).default("unknown")
});

const verificationSchema = z.object({
  verdict: z.enum(["true", "false", "misleading", "unverified"]),
  confidence: z.number().min(0).max(1),
  correction: z.string()
});

export type ReasoningEngine = {
  assessWindow: (sessionId: string, transcriptWindow: TranscriptSegment[]) => Promise<ClaimAssessment | null>;
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
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function hasTerminalPunctuation(text: string) {
  const trimmed = text.trim();
  return /[!?]["')\]]*$/.test(trimmed) || /(?<!\.)\.(?!\.)["')\]]*$/.test(trimmed);
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

export function claimsAreEquivalent(left: string, right: string) {
  const leftIdentity = claimIdentityKey(left);
  const rightIdentity = claimIdentityKey(right);

  if (!leftIdentity || !rightIdentity) {
    return false;
  }

  if (leftIdentity === rightIdentity) {
    return true;
  }

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

  return sharedTokenCount >= 3 && (
    sharedTokenCount / shorterLength >= 0.8 ||
    sharedTokenCount / longerLength >= 0.67
  );
}

export function buildWindowSignature(segments: TranscriptSegment[]) {
  return normalizeWhitespace(
    segments
      .sort((left, right) => left.seq - right.seq)
      .slice(-3)
      .map((segment) => segment.text)
      .join(" ")
  ).toLowerCase();
}

export function shouldAssessWindow(segments: TranscriptSegment[], previousSignature?: string | null) {
  const orderedWindow = segments
    .sort((left, right) => left.seq - right.seq)
    .slice(-3);

  const latestSegment = orderedWindow.at(-1);
  if (!latestSegment) {
    return false;
  }

  const signature = buildWindowSignature(orderedWindow);
  if (!signature || signature === previousSignature) {
    return false;
  }

  const latestText = normalizeWhitespace(latestSegment.text);
  const totalLength = signature.length;
  const latestTokenCount = tokenizeText(latestText).length;

  if (totalLength < 24 || latestText.length < 8) {
    return false;
  }

  if (hasTerminalPunctuation(latestText)) {
    return true;
  }

  return latestTokenCount >= 5 || totalLength >= 72;
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
    `You are a factual claim detector for a two-person debate fact-checker.\n` +
      `Review the transcript and decide whether it contains one clear, verifiable factual claim.\n` +
      `Each line is prefixed with the speaker role ([SELF] or [OPPONENT]).\n` +
      `Ignore filler words, partial fragments, and repeated restatements of the same claim.\n` +
      `Only return a claim when it can stand on its own as a distinct factual assertion.\n` +
      `Do NOT flag clear opinions ("I think...", "I believe...", "In my view..."), rhetorical questions,\n` +
      `or hypotheticals. Focus on verifiable assertions of fact — names, dates, numbers, events, causal claims.\n` +
      `If the claim is attributed to [SELF], apply stricter scrutiny — only flag objectively verifiable statements,\n` +
      `never personal opinions or first-person anecdotes.\n` +
      `CRITICAL: populate the speakerRole field with the tag of the line the claim was drawn from —\n` +
      `"self" if the claim appears on a [SELF] line, "opponent" if it appears on an [OPPONENT] line.\n` +
      `If the claim text spans both speakers or is ambiguous, return "unknown".\n` +
      `Respond only using the requested structured schema.\n\nTranscript:\n{transcript}`
  );

  const verifyPrompt = PromptTemplate.fromTemplate(
    `You are a fact verifier.\n` +
      `Use only the supplied evidence to decide whether the claim is true, false, misleading, or unverifiable.\n` +
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
        transcript: transcriptText
      });

      if (!result.isVerifiable || !result.claimText.trim()) {
        return null;
      }

      // Prefer the speakerRole the LLM assigned (based on the [SELF]/[OPPONENT]
      // line tags). If the model returns "unknown", fall back to the speaker
      // with the largest word share in the window — more robust than
      // always picking the last segment, which gets the attribution wrong
      // whenever the user's mid-claim speaker toggle lands a newer segment
      // in the same 4s window.
      let speakerRole: "self" | "opponent" | "unknown" = result.speakerRole ?? "unknown";
      if (speakerRole === "unknown") {
        const wordsByRole = { self: 0, opponent: 0 };
        for (const segment of transcriptWindow) {
          const role = segment.speakerRole;
          if (role === "self") wordsByRole.self += segment.text.split(/\s+/).length;
          else if (role === "opponent") wordsByRole.opponent += segment.text.split(/\s+/).length;
        }
        if (wordsByRole.self !== wordsByRole.opponent) {
          speakerRole = wordsByRole.self > wordsByRole.opponent ? "self" : "opponent";
        } else {
          // Truly tied (or no labeled segments) — fall back to the latest.
          speakerRole = (transcriptWindow.at(-1)?.speakerRole ?? "unknown") as typeof speakerRole;
        }
      }

      return claimAssessmentSchema.parse({
        claimId: uuidv4(),
        sessionId,
        userId: transcriptWindow.find((segment) => segment.userId)?.userId,
        mode: transcriptWindow.at(-1)?.mode ?? "debate_live",
        transcriptSegmentIds: transcriptWindow.map((segment) => segment.segmentId),
        claimText: result.claimText,
        query: result.query || result.claimText,
        isVerifiable: result.isVerifiable,
        confidence: result.confidence,
        rationale: result.rationale,
        speakerRole
      });
    },
    async verifyClaim(assessment, citations) {
      const evidence = citations
        .map((citation, index) => `${index + 1}. ${citation.title}\n${citation.snippet}\n${citation.url}`)
        .join("\n\n");

      const result = await verifyChain.invoke({
        claim: assessment.claimText,
        evidence
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

async function searchTavily(query: string, apiKey: string): Promise<SourceCitation[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 3,
      include_answer: false,
      search_depth: "basic"
    })
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
        return null;
      }

      const claimText = transcriptText.split(/[.?!]/)[0]?.trim() ?? transcriptText.trim();
      if (!claimText) {
        return null;
      }

      return {
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
        speakerRole: transcriptWindow.at(-1)?.speakerRole ?? "unknown"
      };
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

export async function fetchCitations(query: string, tavilyApiKey?: string) {
  if (!tavilyApiKey) {
    return [] satisfies SourceCitation[];
  }

  const primaryResults = await searchTavily(query, tavilyApiKey);

  if (countHighSignalCitations(primaryResults) >= 1) {
    return curateCitations(primaryResults, query);
  }

  // Single fallback search instead of two parallel ones (saves 1 Tavily credit per claim)
  try {
    const fallbackResults = await searchTavily(`${query} official source`, tavilyApiKey);
    return curateCitations([...primaryResults, ...fallbackResults], query);
  } catch {
    return curateCitations(primaryResults, query);
  }
}

export function buildRollingWindow(segments: TranscriptSegment[]) {
  return segments
    .sort((left, right) => left.seq - right.seq)
    .slice(-3);
}

export function shouldIntervene(result: ClaimVerificationResult, threshold: number) {
  return ["false", "misleading"].includes(result.verdict) && result.confidence >= threshold;
}
