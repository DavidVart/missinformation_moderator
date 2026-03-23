import { z } from "zod";

export const sessionModeSchema = z.enum([
  "debate_live",
  "silent_review",
  "conversation_score",
  "background_capture"
]);

export type SessionMode = z.infer<typeof sessionModeSchema>;

export const verdictSchema = z.enum(["true", "false", "misleading", "unverified"]);
export const leaderboardVisibilitySchema = z.enum(["private", "public"]);

export const topicSlugSchema = z.enum([
  "politics",
  "economics",
  "health",
  "science",
  "technology",
  "education",
  "law",
  "culture",
  "sports",
  "general"
]);

export type TopicSlug = z.infer<typeof topicSlugSchema>;

export const sourceCitationSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  publishedAt: z.string().optional(),
  sourceType: z.enum(["web", "kb", "manual"]).default("web")
});

export type SourceCitation = z.infer<typeof sourceCitationSchema>;

export const topicSummarySchema = z.object({
  topicSlug: topicSlugSchema,
  label: z.string(),
  subtopicSlug: z.string().optional(),
  segmentCount: z.number().int().nonnegative().default(0),
  claimCount: z.number().int().nonnegative().default(0),
  misinformationCount: z.number().int().nonnegative().default(0),
  accuracyScore: z.number().min(0).max(100).default(100),
  highlights: z.array(z.string()).default([])
});

export type TopicSummary = z.infer<typeof topicSummarySchema>;

export const monitoringSessionSchema = z.object({
  sessionId: z.string(),
  deviceId: z.string(),
  userId: z.string().optional(),
  mode: sessionModeSchema,
  status: z.enum(["active", "stopped"]),
  startedAt: z.string(),
  stoppedAt: z.string().optional(),
  chunkMs: z.number().int().positive(),
  sampleRate: z.number().int().positive()
});

export type MonitoringSession = z.infer<typeof monitoringSessionSchema>;

export const sessionEventSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  deviceId: z.string(),
  userId: z.string().optional(),
  mode: sessionModeSchema,
  status: z.enum(["started", "stopped"]),
  startedAt: z.string(),
  stoppedAt: z.string().optional(),
  chunkMs: z.number().int().positive(),
  sampleRate: z.number().int().positive()
});

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionStartPayloadSchema = z.object({
  deviceId: z.string().min(1),
  userId: z.string().optional(),
  mode: sessionModeSchema.default("debate_live"),
  chunkMs: z.literal(4000),
  sampleRate: z.literal(16000),
  preferredLanguage: z.string().min(2).max(8).optional()
});

export type SessionStartPayload = z.infer<typeof sessionStartPayloadSchema>;

export const sessionStopPayloadSchema = z.object({
  sessionId: z.string().min(1)
});

export type SessionStopPayload = z.infer<typeof sessionStopPayloadSchema>;

export const socketAudioChunkPayloadSchema = z.object({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string(),
  pcm16Mono: z.string().min(1)
});

export type SocketAudioChunkPayload = z.infer<typeof socketAudioChunkPayloadSchema>;

export const audioChunkEnvelopeSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  deviceId: z.string(),
  userId: z.string().optional(),
  mode: sessionModeSchema,
  seq: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string(),
  chunkMs: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  language: z.string().min(2).max(8).optional(),
  pcm16MonoBase64: z.string().min(1)
});

export type AudioChunkEnvelope = z.infer<typeof audioChunkEnvelopeSchema>;

export const transcriptSegmentSchema = z.object({
  segmentId: z.string(),
  sessionId: z.string(),
  deviceId: z.string().optional(),
  userId: z.string().optional(),
  mode: sessionModeSchema.default("debate_live"),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  speakerLabel: z.string().default("unknown"),
  speakerId: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const claimAssessmentSchema = z.object({
  claimId: z.string(),
  sessionId: z.string(),
  userId: z.string().optional(),
  mode: sessionModeSchema,
  transcriptSegmentIds: z.array(z.string()).min(1),
  claimText: z.string(),
  query: z.string(),
  isVerifiable: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string()
});

export type ClaimAssessment = z.infer<typeof claimAssessmentSchema>;

export const claimVerificationResultSchema = z.object({
  claimId: z.string(),
  sessionId: z.string(),
  userId: z.string().optional(),
  mode: sessionModeSchema,
  transcriptSegmentIds: z.array(z.string()).min(1),
  claimText: z.string(),
  verdict: verdictSchema,
  confidence: z.number().min(0).max(1),
  correction: z.string(),
  sources: z.array(sourceCitationSchema),
  checkedAt: z.string()
});

export type ClaimVerificationResult = z.infer<typeof claimVerificationResultSchema>;

export const interventionMessageSchema = z.object({
  messageId: z.string(),
  sessionId: z.string(),
  userId: z.string().optional(),
  mode: sessionModeSchema,
  claimId: z.string(),
  claimText: z.string(),
  verdict: verdictSchema,
  confidence: z.number().min(0).max(1),
  correction: z.string(),
  sources: z.array(sourceCitationSchema),
  issuedAt: z.string()
});

export type InterventionMessage = z.infer<typeof interventionMessageSchema>;

export const userSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type User = z.infer<typeof userSchema>;

export const userProfileSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  displayName: z.string().min(1),
  avatar: z.string().url().optional(),
  school: z.string().optional(),
  major: z.string().optional(),
  country: z.string().optional(),
  bio: z.string().optional(),
  leaderboardVisibility: leaderboardVisibilitySchema.default("private"),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type UserProfile = z.infer<typeof userProfileSchema>;

export const magicLinkStartRequestSchema = z.object({
  email: z.string().email(),
  deviceId: z.string().min(1)
});

export const magicLinkStartResponseSchema = z.object({
  ok: z.boolean(),
  expiresInMinutes: z.number().int().positive(),
  previewCode: z.string().optional()
});

export const magicLinkVerifyRequestSchema = z.object({
  email: z.string().email(),
  token: z.string().min(6),
  deviceId: z.string().min(1)
});

export const authSessionSchema = z.object({
  accessToken: z.string(),
  user: userSchema,
  profile: userProfileSchema
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export const profileUpdateRequestSchema = z.object({
  displayName: z.string().min(1),
  avatar: z.string().url().optional().or(z.literal("")).transform((value) => value || undefined),
  school: z.string().optional().or(z.literal("")).transform((value) => value || undefined),
  major: z.string().optional().or(z.literal("")).transform((value) => value || undefined),
  country: z.string().optional().or(z.literal("")).transform((value) => value || undefined),
  bio: z.string().max(280).optional().or(z.literal("")).transform((value) => value || undefined),
  leaderboardVisibility: leaderboardVisibilitySchema
});

export const sessionScoreSchema = z.object({
  sessionId: z.string(),
  userId: z.string().optional(),
  mode: sessionModeSchema,
  accuracyScore: z.number().min(0).max(100),
  falseClaimCount: z.number().int().nonnegative(),
  misleadingClaimCount: z.number().int().nonnegative(),
  verifiedClaimCount: z.number().int().nonnegative(),
  repetitionPenalty: z.number().min(0),
  eligibleForLeaderboard: z.boolean(),
  updatedAt: z.string()
});

export type SessionScore = z.infer<typeof sessionScoreSchema>;

export const reflectionHotspotSchema = z.object({
  label: z.string(),
  topicSlug: topicSlugSchema,
  count: z.number().int().nonnegative()
});

export const monthlyReflectionSchema = z.object({
  reflectionId: z.string(),
  userId: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  averageAccuracyScore: z.number().min(0).max(100),
  scoreTrend: z.number(),
  correctionCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  topTopics: z.array(topicSummarySchema),
  misinformationHotspots: z.array(reflectionHotspotSchema),
  repeatedWeakPoints: z.array(z.string()),
  rankDelta: z.number().int().optional(),
  recommendedTopics: z.array(topicSlugSchema),
  generatedAt: z.string()
});

export type MonthlyReflection = z.infer<typeof monthlyReflectionSchema>;

export const leaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  userId: z.string(),
  displayName: z.string(),
  avatar: z.string().url().optional(),
  school: z.string().optional(),
  major: z.string().optional(),
  score: z.number().min(0).max(100),
  sessionsCount: z.number().int().nonnegative(),
  correctionsCount: z.number().int().nonnegative(),
  topicSlug: topicSlugSchema.optional()
});

export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const leaderboardResponseSchema = z.object({
  scope: z.enum(["global", "school", "major", "topic"]),
  scopeValue: z.string().optional(),
  minimumCohortMet: z.boolean().default(true),
  entries: z.array(leaderboardEntrySchema)
});

export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>;

export const cohortLeaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  label: z.string(),
  score: z.number().min(0).max(100),
  sessionsCount: z.number().int().nonnegative(),
  correctionsCount: z.number().int().nonnegative(),
  publicUserCount: z.number().int().nonnegative()
});

export type CohortLeaderboardEntry = z.infer<typeof cohortLeaderboardEntrySchema>;

export const cohortLeaderboardResponseSchema = z.object({
  scope: z.enum(["school", "major"]),
  minimumCohortMet: z.boolean().default(true),
  entries: z.array(cohortLeaderboardEntrySchema)
});

export type CohortLeaderboardResponse = z.infer<typeof cohortLeaderboardResponseSchema>;

export const topicMisinformationPointSchema = z.object({
  claimText: z.string(),
  verdict: verdictSchema,
  correction: z.string(),
  sessionId: z.string(),
  checkedAt: z.string()
});

export type TopicMisinformationPoint = z.infer<typeof topicMisinformationPointSchema>;

export const topicPreferenceSchema = z.object({
  topicSlug: topicSlugSchema,
  following: z.boolean().default(true)
});

export type TopicPreference = z.infer<typeof topicPreferenceSchema>;

export const newsArticleSchema = z.object({
  articleId: z.string(),
  title: z.string(),
  topicSlug: topicSlugSchema,
  sourceName: z.string(),
  url: z.string().url(),
  summary: z.string(),
  whyItMatters: z.string(),
  relatedWeakPoint: z.string().optional(),
  publishedAt: z.string(),
  saved: z.boolean().default(false)
});

export type NewsArticle = z.infer<typeof newsArticleSchema>;

export const newsFeedResponseSchema = z.object({
  dailyBrief: z.array(newsArticleSchema),
  topicExplainers: z.array(newsArticleSchema),
  correctionReading: z.array(newsArticleSchema),
  saved: z.array(newsArticleSchema)
});

export type NewsFeedResponse = z.infer<typeof newsFeedResponseSchema>;

export const newsPreferencesRequestSchema = z.object({
  followedTopics: z.array(topicSlugSchema).min(1)
});

export const newsSaveRequestSchema = z.object({
  articleId: z.string(),
  saved: z.boolean().default(true)
});

export type RedisStreamRecord<T> = {
  id: string;
  payload: T;
};

export function serializeStreamPayload<T>(payload: T): Record<string, string> {
  return {
    payload: JSON.stringify(payload)
  };
}

export function parseStreamPayload<TSchema extends z.ZodTypeAny>(
  value: string,
  schema: TSchema
): z.output<TSchema> {
  return schema.parse(JSON.parse(value));
}
