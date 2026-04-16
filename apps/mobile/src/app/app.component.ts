import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { IonApp, IonIcon, IonSpinner } from "@ionic/angular/standalone";
import { addIcons } from "ionicons";
import {
  analyticsOutline,
  archiveOutline,
  barChartOutline,
  checkmarkCircleOutline,
  closeOutline,
  createOutline,
  documentTextOutline,
  flashOutline,
  logOutOutline,
  micOutline,
  personOutline,
  pulseOutline,
  personCircleOutline,
  podiumOutline,
  radioButtonOnOutline,
  ribbonOutline,
  schoolOutline,
  settingsOutline,
  shieldCheckmarkOutline,
  sparklesOutline,
  stopCircleOutline,
  timeOutline,
  trendingUpOutline,
  trophyOutline,
  volumeHighOutline,
  warningOutline,
  chatbubblesOutline,
  eyeOffOutline,
  statsChartOutline,
  earOutline,
  calendarOutline,
  arrowBackOutline,
  arrowForwardOutline,
  chevronForwardOutline,
  gridOutline,
  newspaperOutline
} from "ionicons/icons";
import { Subscription } from "rxjs";

import type {
  CohortLeaderboardEntry,
  InterventionMessage,
  LeaderboardEntry,
  MonthlyReflection,
  SessionMode,
  TopicMisinformationPoint,
  TopicSummary,
  TranscriptSegment
} from "@project-veritas/contracts";

import { AnalyticsApiService } from "./core/analytics/analytics-api.service";
import { PosthogService } from "./core/analytics/posthog.service";
import { AttributionApiService } from "./core/attribution/attribution-api.service";
import { AudioCaptureService } from "./core/audio/audio-capture.service";
import { AuthService } from "./core/auth/auth.service";
import { HistoryApiService } from "./core/history/history-api.service";
import { MonitoringSocketService } from "./core/monitoring/monitoring-socket.service";
import { SpeakerStateService } from "./core/speakers/speaker-state.service";
import { SpeechService } from "./core/speech/speech.service";

type AppTab = "live" | "insights" | "rankings" | "profile";

type RankingsSubTab = "global" | "schools" | "majors";

type InsightsSubTab = "session" | "topics" | "trends" | "history";

type PastSession = {
  sessionId: string;
  mode: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  durationMs: number;
  segmentCount: number;
  correctionCount: number;
  accuracyScore: number | null;
};

type SessionModeOption = {
  mode: SessionMode;
  icon: string;
  title: string;
  description: string;
};

type TopicInfo = {
  slug: string;
  label: string;
  icon: string;
};

type StatusReadout = {
  label: string;
  value: string;
  emphasis?: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildMeterBars(count: number, phase: number, intensity: number, minHeight: number, maxHeight: number) {
  return Array.from({ length: count }, (_, index) => {
    const center = (count - 1) / 2;
    const spread = center === 0 ? 1 : Math.abs(index - center) / center;
    const profile = 1 - spread * 0.48;
    const harmonic =
      Math.sin(phase * 0.9 + index * 0.72) +
      Math.sin(phase * 0.47 + index * 1.35) * 0.55 +
      Math.cos(phase * 0.32 + index * 0.95) * 0.35;
    const normalizedWave = (harmonic + 1.9) / 3.8;
    const amplitude = clamp(0.14 + intensity * profile * normalizedWave, 0.12, 1);
    return Math.round(minHeight + amplitude * (maxHeight - minHeight));
  });
}

@Component({
  selector: "app-root",
  imports: [
    CommonModule,
    FormsModule,
    IonApp,
    IonIcon,
    IonSpinner
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnDestroy {
  private static readonly CAPTURE_STEP_MS = 2000;
  private readonly socketService = inject(MonitoringSocketService);
  private readonly audioCaptureService = inject(AudioCaptureService);
  private readonly historyApi = inject(HistoryApiService);
  private readonly analyticsApi = inject(AnalyticsApiService);
  private readonly speechService = inject(SpeechService);
  private readonly posthog = inject(PosthogService);
  protected readonly auth = inject(AuthService);
  protected readonly speakerState = inject(SpeakerStateService);
  private readonly attributionApi = inject(AttributionApiService);
  private readonly subscriptions = new Subscription();

  // V2: post-session attribution modal state
  protected readonly attributionModalOpen = signal(false);
  protected readonly attributionQuery = signal("");
  protected readonly attributionSearchResults = signal<Array<{ userId: string; displayName: string; email?: string; avatar?: string; school?: string }>>([]);
  protected readonly attributionSubmitting = signal(false);
  protected readonly attributionError = signal<string | null>(null);
  protected readonly attributionCompletedForSessionId = signal<string | null>(null);

  // V2: voice enrollment state (for future auto-diarization)
  protected readonly voiceEnrollmentState = signal<"idle" | "recording" | "uploading" | "enrolled">("idle");
  protected readonly voiceEnrollmentCountdown = signal(10);

  protected readonly isMonitoring = signal(false);
  protected readonly isBusy = signal(false);
  protected readonly sessionId = signal<string | null>(null);
  protected readonly transcriptSegments = signal<TranscriptSegment[]>([]);
  protected readonly interventions = signal<InterventionMessage[]>([]);
  protected readonly statusMessage = signal("Ready to moderate");
  protected readonly micError = signal<string | null>(null);
  protected readonly transportStatus = signal<"connecting" | "connected" | "offline">("connecting");
  protected readonly activeTab = signal<AppTab>("live");
  protected readonly isCorrectionOpen = signal(true);
  protected readonly isModeSheetOpen = signal(false);
  private correctionDismissTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly activityLevel = signal(0);
  protected readonly ambientTick = signal(0);
  protected readonly uiNowMs = signal(Date.now());
  protected readonly sessionStartedAtMs = signal<number | null>(null);

  // ───────────────── Session mode ─────────────────
  protected readonly selectedMode = signal<SessionMode>("debate_live");
  protected readonly sessionModes: SessionModeOption[] = [
    { mode: "debate_live", icon: "chatbubbles-outline", title: "Debate Live", description: "Real-time corrections as you speak" },
    { mode: "conversation_score", icon: "stats-chart-outline", title: "Talk + Score", description: "Score accuracy after session ends" },
    { mode: "silent_review", icon: "eye-off-outline", title: "Silent Review", description: "No interruptions, review later" },
    { mode: "background_capture", icon: "ear-outline", title: "Background", description: "Capture ambient conversation" }
  ];

  // ───────────────── Rankings ─────────────────
  protected readonly rankingsSubTab = signal<RankingsSubTab>("global");
  protected readonly globalLeaderboard = signal<LeaderboardEntry[]>([]);
  protected readonly schoolLeaderboard = signal<CohortLeaderboardEntry[]>([]);
  protected readonly majorLeaderboard = signal<CohortLeaderboardEntry[]>([]);
  protected readonly rankingsLoading = signal(false);

  // ───────────────── Insights sub-tabs ─────────────────
  protected readonly insightsSubTab = signal<InsightsSubTab>("session");

  // ───────────────── Monthly reflections ─────────────────
  protected readonly currentReflectionMonth = signal(this.getCurrentMonth());
  protected readonly monthlyReflection = signal<MonthlyReflection | null>(null);
  protected readonly reflectionLoading = signal(false);

  // ───────────────── Topic breakdown ─────────────────
  protected readonly sessionTopics = signal<TopicSummary[]>([]);
  protected readonly selectedTopicSlug = signal<string | null>(null);
  protected readonly topicMisinformation = signal<TopicMisinformationPoint[]>([]);
  protected readonly topicsLoading = signal(false);

  protected readonly allTopics: TopicInfo[] = [
    { slug: "politics", label: "Politics", icon: "podium-outline" },
    { slug: "economics", label: "Economics", icon: "trending-up-outline" },
    { slug: "health", label: "Health", icon: "pulse-outline" },
    { slug: "science", label: "Science", icon: "flash-outline" },
    { slug: "technology", label: "Technology", icon: "grid-outline" },
    { slug: "education", label: "Education", icon: "school-outline" },
    { slug: "law", label: "Law", icon: "shield-checkmark-outline" },
    { slug: "culture", label: "Culture", icon: "sparkles-outline" },
    { slug: "sports", label: "Sports", icon: "trophy-outline" },
    { slug: "general", label: "General", icon: "newspaper-outline" }
  ];

  // ───────────────── Session History ─────────────────
  protected readonly pastSessions = signal<PastSession[]>([]);
  protected readonly pastSessionsTotal = signal(0);
  protected readonly historyLoading = signal(false);

  // ───────────────── Profile editing ─────────────────
  protected readonly isEditingProfile = signal(false);
  protected readonly profileSaving = signal(false);
  protected readonly editSchool = signal("");
  protected readonly editMajor = signal("");
  protected readonly editBio = signal("");
  protected readonly editCountry = signal("");
  protected readonly editLeaderboardVisibility = signal<"public" | "private">("private");

  // ───────────────── App preferences (localStorage) ─────────────────
  protected readonly prefAutoSpeak = signal(this.loadPref("rt-auto-speak", false));
  protected readonly prefLanguage = signal(this.loadPref("rt-language", "auto"));

  protected readonly selectedModeLabel = computed(() => {
    const mode = this.selectedMode();
    return this.sessionModes.find((m) => m.mode === mode)?.title ?? mode;
  });
  protected readonly latestIntervention = computed(() => this.interventions()[0] ?? null);
  protected readonly hasSessionData = computed(() => this.transcriptSegments().length > 0 || this.interventions().length > 0);
  protected readonly modeShowsRealtimeOverlay = computed(() =>
    this.selectedMode() === "debate_live"
  );
  protected readonly showCorrectionOverlay = computed(
    () => this.modeShowsRealtimeOverlay() && (this.activeTab() === "live" || this.activeTab() === "insights") && this.isCorrectionOpen() && !!this.latestIntervention()
  );
  protected readonly transcriptFeed = computed(() => this.transcriptSegments().slice(-8));
  protected readonly unifiedTranscript = computed(() => {
    const segments = this.transcriptSegments();
    const corrections = this.interventions();
    if (segments.length === 0) return [];

    // Build a timeline: each segment has text + timestamp, corrections get inserted at their timestamp
    const correctionTimes = new Map<number, string>();
    for (const c of corrections) {
      const t = Date.parse(c.issuedAt);
      if (Number.isFinite(t)) {
        correctionTimes.set(t, c.correction);
      }
    }

    // Merge segments into runs of text, inserting correction markers between segments
    const parts: { type: "text" | "correction"; content: string }[] = [];
    for (const segment of segments) {
      const segEnd = Date.parse(segment.endedAt ?? segment.startedAt);
      // Check if any correction was issued around this segment
      for (const [cTime, cText] of correctionTimes) {
        if (cTime <= segEnd + 2000 && cTime >= Date.parse(segment.startedAt) - 1000) {
          parts.push({ type: "correction", content: cText });
          correctionTimes.delete(cTime);
        }
      }
      parts.push({ type: "text", content: segment.text });
    }
    return parts;
  });

  /**
   * V2: transcript grouped into speaker bubbles. Consecutive segments from the
   * same speaker are merged into one bubble. Corrections are attached to the
   * bubble they landed inside (so the speaker attribution reads naturally).
   */
  protected readonly speakerTranscript = computed(() => {
    const segments = this.transcriptSegments();
    const corrections = this.interventions();

    if (segments.length === 0) {
      return [] as Array<{
        speaker: "self" | "opponent" | "unknown";
        label: string;
        text: string;
        startedAt: string;
        corrections: string[];
      }>;
    }

    // Build lookup: correction timestamps → correction + attributedTo
    const correctionEntries = corrections
      .map((c) => ({
        time: Date.parse(c.issuedAt),
        text: c.correction,
        attributedTo: c.attributedTo ?? "unknown"
      }))
      .filter((entry) => Number.isFinite(entry.time));

    const bubbles: Array<{
      speaker: "self" | "opponent" | "unknown";
      label: string;
      text: string;
      startedAt: string;
      endedAt: string;
      corrections: string[];
    }> = [];

    for (const segment of segments) {
      const speaker = (segment.speakerRole ?? "unknown") as "self" | "opponent" | "unknown";
      const label = speaker === "self" ? "You" : speaker === "opponent" ? "Opponent" : "Speaker";

      const last = bubbles.at(-1);
      if (last && last.speaker === speaker) {
        last.text = `${last.text} ${segment.text}`.trim();
        last.endedAt = segment.endedAt ?? last.endedAt;
      } else {
        bubbles.push({
          speaker,
          label,
          text: segment.text,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt ?? segment.startedAt,
          corrections: []
        });
      }
    }

    // Attach each correction to whichever bubble it landed inside (or the
    // closest one by time if no direct overlap). Only attach when the
    // correction's `attributedTo` matches the bubble's speaker — that way a
    // correction on "self" speech doesn't dangle on an opponent bubble.
    for (const entry of correctionEntries) {
      let bestMatch: (typeof bubbles)[number] | null = null;
      let bestDistance = Infinity;
      for (const bubble of bubbles) {
        if (bubble.speaker !== entry.attributedTo && entry.attributedTo !== "unknown") {
          continue;
        }
        const bubbleStart = Date.parse(bubble.startedAt);
        const bubbleEnd = Date.parse(bubble.endedAt);
        const distance =
          entry.time >= bubbleStart && entry.time <= bubbleEnd + 3000
            ? 0
            : Math.min(Math.abs(entry.time - bubbleStart), Math.abs(entry.time - bubbleEnd));
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = bubble;
        }
      }
      if (bestMatch) {
        bestMatch.corrections.push(entry.text);
      }
    }

    return bubbles.map(({ endedAt: _endedAt, ...rest }) => rest);
  });

  /**
   * V2: per-speaker stats for the post-debate Insights tab — segment count,
   * correction count, accuracy for each speaker side.
   */
  protected readonly speakerBreakdown = computed(() => {
    const segments = this.transcriptSegments();
    const corrections = this.interventions();

    const stats = {
      self: { segments: 0, corrections: 0, accuracy: 100 },
      opponent: { segments: 0, corrections: 0, accuracy: 100 }
    };

    for (const seg of segments) {
      const role = seg.speakerRole;
      if (role === "self") stats.self.segments += 1;
      if (role === "opponent") stats.opponent.segments += 1;
    }
    for (const corr of corrections) {
      const role = corr.attributedTo;
      if (role === "self") stats.self.corrections += 1;
      if (role === "opponent") stats.opponent.corrections += 1;
    }

    for (const side of [stats.self, stats.opponent] as const) {
      if (side.segments === 0) {
        side.accuracy = 100;
      } else {
        const ratio = Math.max(0, side.segments - side.corrections) / side.segments;
        side.accuracy = Math.round(ratio * 100);
      }
    }

    return stats;
  });
  protected readonly archiveFeed = computed(() => this.interventions().slice(0, 8));
  protected readonly sessionMetrics = computed(() => ({
    duration: this.formatDurationLabel(),
    corrections: this.interventions().length,
    segments: this.transcriptSegments().length
  }));
  protected readonly transportPillLabel = computed(() => {
    if (this.transportStatus() === "connected") {
      return "Linked";
    }

    if (this.transportStatus() === "connecting") {
      return "Syncing";
    }

    return "Offline";
  });
  protected readonly homeStatusLabel = computed(() => {
    if (this.transportStatus() === "connected") {
      return "Ready to analyze conversations";
    }

    if (this.transportStatus() === "connecting") {
      return "Establishing connection";
    }

    return "Backend offline";
  });
  protected readonly sessionGlanceItems = computed<StatusReadout[]>(() => [
    {
      label: "Segments",
      value: String(this.transcriptSegments().length).padStart(2, "0")
    },
    {
      label: "Corrections",
      value: String(this.interventions().length).padStart(2, "0"),
      emphasis: this.interventions().length > 0
    },
    {
      label: "Cadence",
      value: "4s / 2s"
    }
  ]);
  protected readonly sessionWaveBars = computed(() => {
    const baseIntensity = this.isMonitoring()
      ? clamp(0.34 + this.activityLevel() * 0.95, 0.34, 1)
      : clamp(0.16 + this.transcriptSegments().length * 0.05, 0.18, 0.52);

    return buildMeterBars(9, this.ambientTick() * 1.4, baseIntensity, 20, 126);
  });
  protected readonly accuracyPercent = computed(() => {
    const segments = this.transcriptSegments().length;
    const corrections = this.interventions().length;
    if (segments === 0) return 100;
    const ratio = Math.max(0, segments - corrections) / segments;
    return Math.round(ratio * 100);
  });
  protected readonly accuracyRingDash = computed(() => {
    const circumference = 2 * Math.PI * 34; // r=34
    const filled = (this.accuracyPercent() / 100) * circumference;
    return `${filled} ${circumference}`;
  });
  protected readonly transcriptWaitingCopy = computed(() => {
    if (this.isMonitoring()) {
      return "Listening live. The first transcript window lands after the current 4-second capture closes.";
    }

    return "Transcript will appear here once the first audio window completes.";
  });
  protected readonly captureProgress = computed(() => {
    if (!this.isMonitoring()) {
      return this.hasSessionData() ? 1 : 0;
    }

    const startedAtMs = this.sessionStartedAtMs();
    if (!startedAtMs) {
      return 0;
    }

    const elapsedMs = Math.max(0, this.uiNowMs() - startedAtMs);
    return (elapsedMs % AppComponent.CAPTURE_STEP_MS) / AppComponent.CAPTURE_STEP_MS;
  });
  protected readonly nextWindowEta = computed(() => {
    if (!this.isMonitoring()) {
      return this.hasSessionData() ? "Paused" : "Standby";
    }

    const remainingMs = Math.max(0, Math.round((1 - this.captureProgress()) * AppComponent.CAPTURE_STEP_MS));
    return `${(remainingMs / 1000).toFixed(1)}s`;
  });
  protected readonly activityStatusLabel = computed(() => {
    if (!this.isMonitoring()) {
      return this.hasSessionData() ? "Session paused" : "Awaiting microphone";
    }

    const level = this.activityLevel();
    if (level >= 0.62) {
      return "Strong voice activity";
    }
    if (level >= 0.28) {
      return "Active discussion";
    }
    return "Quiet room";
  });
  protected readonly latestSource = computed(() => this.latestIntervention()?.sources[0] ?? null);
  protected readonly correctionConfidenceLabel = computed(() => {
    const intervention = this.latestIntervention();
    if (!intervention) {
      return "No correction";
    }

    return `${Math.round(intervention.confidence * 100)}% confidence`;
  });

  protected readonly reflectionScoreLabel = computed(() => {
    const reflection = this.monthlyReflection();
    if (!reflection) return "—";
    return `${Math.round(reflection.averageAccuracyScore)}%`;
  });
  protected readonly reflectionTrendLabel = computed(() => {
    const reflection = this.monthlyReflection();
    if (!reflection) return "";
    const trend = reflection.scoreTrend;
    if (trend > 0) return `+${trend.toFixed(1)} from last month`;
    if (trend < 0) return `${trend.toFixed(1)} from last month`;
    return "No change from last month";
  });
  protected readonly reflectionMonthLabel = computed(() => {
    const [year, month] = this.currentReflectionMonth().split("-");
    const date = new Date(Number(year), Number(month) - 1);
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  });

  private readonly deviceId = this.ensureDeviceId();
  private readonly ambientTimer = globalThis.setInterval(() => {
    this.ambientTick.update((tick) => tick + 1);
    this.uiNowMs.set(Date.now());
  }, 320);

  ngOnDestroy() {
    globalThis.clearInterval(this.ambientTimer);
    this.subscriptions.unsubscribe();
  }

  constructor() {
    addIcons({
      analyticsOutline,
      archiveOutline,
      arrowBackOutline,
      arrowForwardOutline,
      barChartOutline,
      calendarOutline,
      chatbubblesOutline,
      checkmarkCircleOutline,
      chevronForwardOutline,
      closeOutline,
      createOutline,
      documentTextOutline,
      earOutline,
      eyeOffOutline,
      flashOutline,
      gridOutline,
      logOutOutline,
      micOutline,
      newspaperOutline,
      personOutline,
      podiumOutline,
      pulseOutline,
      personCircleOutline,
      radioButtonOnOutline,
      ribbonOutline,
      schoolOutline,
      settingsOutline,
      shieldCheckmarkOutline,
      sparklesOutline,
      statsChartOutline,
      stopCircleOutline,
      timeOutline,
      trendingUpOutline,
      trophyOutline,
      volumeHighOutline,
      warningOutline
    });

    // Initialize SDKs
    this.posthog.init();
    void this.auth.init();

    // Mobile auth handoff: when the Vercel web app is opened from the native
    // app (?mobileAuth=1), perform the Clerk sign-in flow here (where cookies
    // work) and redirect back to the native app via the custom URL scheme
    // with the user's info + session JWT. See auth.service.ts for the native
    // side that receives this redirect.
    this.maybeHandleMobileAuthHandoff();

    // Pre-warm the Socket.IO connection so the Render service wakes up from
    // cold-start while the user is still on the home screen, rather than
    // making them wait when they press the mic button.
    this.socketService.connect();

    // Sync Clerk profile to analytics DB whenever user signs in
    effect(() => {
      const userId = this.auth.userId();
      const displayName = this.auth.displayName();
      if (userId && displayName) {
        const meta = this.auth.profileMeta();
        this.analyticsApi.syncProfile({
          userId,
          displayName,
          email: this.auth.email() ?? undefined,
          avatar: this.auth.avatarUrl() ?? undefined,
          school: meta.school || undefined,
          major: meta.major || undefined,
          country: meta.country || undefined,
          bio: meta.bio || undefined,
          leaderboardVisibility: meta.leaderboardVisibility
        }).catch(() => {
          // Profile sync is best-effort — don't block the user experience
        });
      }
    });

    this.subscriptions.add(
      this.socketService.connectionState$.subscribe((state) => {
        this.transportStatus.set(state);
      })
    );

    this.subscriptions.add(
      this.socketService.transcript$.subscribe((segment) => {
        this.transcriptSegments.update((segments) => [...segments, segment]);
      })
    );

    this.subscriptions.add(
      this.socketService.intervention$.subscribe((message) => {
        this.interventions.update((messages) => [message, ...messages].slice(0, 8));

        // Only show real-time overlay and status update for debate_live mode
        if (this.modeShowsRealtimeOverlay()) {
          this.statusMessage.set("Correction ready");
          this.isCorrectionOpen.set(true);

          // Clear any previous dismiss timer so a new correction resets the countdown
          if (this.correctionDismissTimer) {
            clearTimeout(this.correctionDismissTimer);
          }

          // Auto-dismiss after 12 seconds so the overlay doesn't block forever
          this.correctionDismissTimer = setTimeout(() => {
            this.isCorrectionOpen.set(false);
            this.correctionDismissTimer = null;
          }, 12_000);
        }

        void this.refreshHistory();
      })
    );

    this.subscriptions.add(
      this.audioCaptureService.levels$.subscribe((level) => {
        this.activityLevel.set(level);
      })
    );

    // V2: feed the audio capture service a provider that returns the user's
    // current speaker toggle state. Read on every chunk emission so mid-session
    // toggles take effect immediately on the next chunk.
    this.audioCaptureService.setSpeakerRoleProvider(() => this.speakerState.currentSpeaker());

    this.subscriptions.add(
      this.audioCaptureService.chunks$.subscribe(async (chunk) => {
        const activeSessionId = this.sessionId();
        if (!activeSessionId) {
          return;
        }

        await this.socketService.sendChunk({
          sessionId: activeSessionId,
          ...chunk
        });
      })
    );

    this.socketService.connect();

    // Pre-load session count for quick stats on landing
    void this.loadPastSessions();
  }

  protected selectTab(tab: AppTab) {
    this.activeTab.set(tab);
    if (tab !== "live" && tab !== "insights") {
      this.isCorrectionOpen.set(false);
    }
    if (tab === "rankings") {
      void this.loadRankings();
    }
    if (tab === "insights") {
      this.insightsSubTab.set("session");
      void this.loadMonthlyReflection();
      void this.loadSessionTopics();
    }
  }

  protected selectInsightsSubTab(sub: InsightsSubTab) {
    this.insightsSubTab.set(sub);
    if (sub === "topics") {
      void this.loadSessionTopics();
    }
    if (sub === "trends") {
      void this.loadMonthlyReflection();
    }
    if (sub === "history") {
      void this.loadPastSessions();
    }
  }

  protected closeCorrectionOverlay() {
    this.isCorrectionOpen.set(false);
  }

  protected async toggleMonitoring() {
    if (this.isMonitoring()) {
      await this.stopMonitoring();
      return;
    }

    await this.startMonitoring();
  }

  protected async speakLatestIntervention() {
    const intervention = this.latestIntervention();
    if (!intervention) {
      return;
    }

    const suppressionDurationMs = this.speechService.estimateDurationMs(intervention.correction) + 1_000;
    this.audioCaptureService.suppressFor(suppressionDurationMs);
    await this.speechService.speak(intervention.correction);
    this.statusMessage.set("Correction delivered");
  }

  protected openLatestSource() {
    const source = this.latestSource();
    if (!source) {
      return;
    }

    globalThis.open?.(source.url, "_blank", "noopener,noreferrer");
  }

  protected sourceHost(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      return url;
    }
  }

  protected trackById(_index: number, item: { id?: string; messageId?: string; segmentId?: string }) {
    return item.id ?? item.messageId ?? item.segmentId ?? _index;
  }

  protected sessionHeaderLabel() {
    if (this.isMonitoring()) {
      return "Listening...";
    }

    if (this.hasSessionData()) {
      return "Session paused";
    }

    return "Ready";
  }

  // ───────────────────── Profile Editing ─────────────────────

  protected startEditingProfile() {
    const meta = this.auth.profileMeta();
    this.editSchool.set(meta.school);
    this.editMajor.set(meta.major);
    this.editBio.set(meta.bio);
    this.editCountry.set(meta.country);
    this.editLeaderboardVisibility.set(meta.leaderboardVisibility);
    this.isEditingProfile.set(true);
  }

  protected cancelEditingProfile() {
    this.isEditingProfile.set(false);
  }

  protected async saveProfile() {
    this.profileSaving.set(true);
    try {
      const school = this.editSchool().trim();
      const major = this.editMajor().trim();
      const bio = this.editBio().trim();
      const country = this.editCountry().trim();
      const leaderboardVisibility = this.editLeaderboardVisibility();

      await this.auth.updateProfileMeta({ school, major, bio, country, leaderboardVisibility });

      // Sync profile to analytics service so leaderboard/reflections have the data
      const userId = this.auth.userId();
      if (userId) {
        void this.analyticsApi.syncProfile({
          userId,
          displayName: this.auth.displayName(),
          email: this.auth.email() ?? undefined,
          avatar: this.auth.avatarUrl() ?? undefined,
          school: school || undefined,
          major: major || undefined,
          country: country || undefined,
          bio: bio || undefined,
          leaderboardVisibility
        });
      }

      this.isEditingProfile.set(false);
      this.posthog.capture("profile_updated");
    } catch (error) {
      console.error("Failed to save profile:", error);
    } finally {
      this.profileSaving.set(false);
    }
  }

  protected toggleAutoSpeak() {
    const next = !this.prefAutoSpeak();
    this.prefAutoSpeak.set(next);
    this.savePref("rt-auto-speak", next);
  }

  private loadPref<T>(key: string, fallback: T): T {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored !== null ? JSON.parse(stored) as T : fallback;
    } catch {
      return fallback;
    }
  }

  private savePref<T>(key: string, value: T) {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // silently fail
    }
  }

  // ───────────────────── Auth methods (Clerk) ─────────────────────

  protected openSignIn() {
    this.posthog.capture("sign_in_opened");
    void this.auth.openSignIn();
  }

  protected openSignUp() {
    this.posthog.capture("sign_up_opened");
    void this.auth.openSignUp();
  }

  protected openUserProfile() {
    void this.auth.openUserProfile();
  }

  protected signOut() {
    this.posthog.capture("sign_out");
    this.posthog.reset();
    void this.auth.signOut();
  }

  // ───────────────────── Session Modes ─────────────────────

  protected openModeSheet() {
    this.isModeSheetOpen.set(true);
  }

  protected closeModeSheet() {
    this.isModeSheetOpen.set(false);
  }

  protected selectSessionMode(mode: SessionMode) {
    this.selectedMode.set(mode);
    this.posthog.capture("session_mode_selected", { mode });
  }

  // ───────────────────── Rankings ─────────────────────

  protected selectRankingsSubTab(sub: RankingsSubTab) {
    this.rankingsSubTab.set(sub);
    void this.loadRankings(sub);
  }

  protected async loadRankings(sub?: RankingsSubTab) {
    const tab = sub ?? this.rankingsSubTab();
    this.rankingsLoading.set(true);
    try {
      if (tab === "global") {
        const data = await this.analyticsApi.getGlobalLeaderboard();
        this.globalLeaderboard.set(data.entries);
      } else if (tab === "schools") {
        const data = await this.analyticsApi.getSchoolLeaderboard();
        this.schoolLeaderboard.set(data.entries);
      } else if (tab === "majors") {
        const data = await this.analyticsApi.getMajorLeaderboard();
        this.majorLeaderboard.set(data.entries);
      }
    } catch {
      // Silently fail — empty state will show
    } finally {
      this.rankingsLoading.set(false);
    }
  }

  // ───────────────────── Monthly Reflections ─────────────────────

  protected async loadMonthlyReflection() {
    this.reflectionLoading.set(true);
    try {
      const userId = this.auth.userId() ?? undefined;
      const reflection = await this.analyticsApi.getMonthlyReflection(this.currentReflectionMonth(), userId);
      this.monthlyReflection.set(reflection);
    } catch {
      this.monthlyReflection.set(null);
    } finally {
      this.reflectionLoading.set(false);
    }
  }

  protected navigateReflectionMonth(delta: number) {
    const [year, month] = this.currentReflectionMonth().split("-").map(Number);
    const date = new Date(year!, month! - 1 + delta);
    const newMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    this.currentReflectionMonth.set(newMonth);
    void this.loadMonthlyReflection();
  }

  private getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  // ───────────────────── Topic Breakdown ─────────────────────

  protected async loadSessionTopics() {
    const currentSessionId = this.sessionId();
    if (!currentSessionId) return;
    this.topicsLoading.set(true);
    try {
      const topics = await this.analyticsApi.getSessionTopics(currentSessionId);
      this.sessionTopics.set(topics);
    } catch {
      this.sessionTopics.set([]);
    } finally {
      this.topicsLoading.set(false);
    }
  }

  protected async selectTopic(slug: string) {
    this.selectedTopicSlug.set(slug);
    try {
      const points = await this.analyticsApi.getTopicMisinformation(slug);
      this.topicMisinformation.set(points);
    } catch {
      this.topicMisinformation.set([]);
    }
  }

  protected clearSelectedTopic() {
    this.selectedTopicSlug.set(null);
    this.topicMisinformation.set([]);
  }

  protected topicLabel(slug: string): string {
    return this.allTopics.find((t) => t.slug === slug)?.label ?? slug;
  }

  // ───────────────────── Session History ─────────────────────

  protected async loadPastSessions() {
    this.historyLoading.set(true);
    try {
      const userId = this.auth.userId?.() ?? undefined;
      const data = await this.historyApi.listSessions({
        userId,
        deviceId: this.deviceId,
        limit: 20
      });
      this.pastSessions.set(data.sessions as PastSession[]);
      this.pastSessionsTotal.set(data.total);
    } catch {
      this.pastSessions.set([]);
      this.pastSessionsTotal.set(0);
    } finally {
      this.historyLoading.set(false);
    }
  }

  protected formatSessionDuration(ms: number): string {
    if (ms <= 0) return "0m 00s";
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  protected sessionModeLabel(mode: string): string {
    const labels: Record<string, string> = {
      debate_live: "Debate Live",
      conversation_score: "Talk + Score",
      silent_review: "Silent Review",
      background_capture: "Background"
    };
    return labels[mode] ?? mode;
  }

  // ─────────────── Mobile auth handoff (Vercel web) ───────────────

  /**
   * Detect the `?mobileAuth=1` query param set when the native app opens this
   * Vercel-hosted web app via the in-app browser. When present, we:
   *   1. Wait for Clerk to be ready
   *   2. If not signed in, open the Clerk sign-in modal
   *   3. Once signed in, build a deep-link URL with the user info + session
   *      token and redirect to `com.realtalk.mobile://auth?...`, which the
   *      native app receives via its URL scheme listener.
   */
  private maybeHandleMobileAuthHandoff() {
    const loc = globalThis.location;
    if (!loc) {
      return;
    }
    const params = new URLSearchParams(loc.search);
    if (params.get("mobileAuth") !== "1") {
      return;
    }

    const scheme = params.get("scheme") || "com.realtalk.mobile";
    const returnUrl = `/?mobileAuth=1&scheme=${encodeURIComponent(scheme)}`;
    let handoffDone = false;
    let signInTriggered = false;

    // React to Clerk ready/signed-in state changes.
    effect(() => {
      if (handoffDone) {
        return;
      }
      if (!this.auth.isReady()) {
        return;
      }

      if (this.auth.isSignedIn()) {
        handoffDone = true;
        void this.performMobileAuthRedirect(scheme);
      } else if (!signInTriggered) {
        signInTriggered = true;
        // Redirect the user directly to Clerk's full hosted sign-in page
        // (with Google / Apple / X options), not the modal. After sign-in,
        // Clerk brings them back to `/?mobileAuth=1&scheme=...` and this
        // effect fires again with isSignedIn() === true → deep-link redirect.
        const clerk = (globalThis as Record<string, unknown>)["Clerk"] as
          | { redirectToSignIn?: (opts?: { afterSignInUrl?: string; afterSignUpUrl?: string }) => void }
          | undefined;
        if (clerk?.redirectToSignIn) {
          clerk.redirectToSignIn({ afterSignInUrl: returnUrl, afterSignUpUrl: returnUrl });
        } else {
          // Fallback: trigger whatever Clerk flow the auth service provides.
          void this.auth.openSignIn();
        }
      }
    });
  }

  private async performMobileAuthRedirect(scheme: string) {
    // Retrieve the Clerk session JWT for the native app to use as a bearer
    // token on authenticated API calls.
    let token = "";
    try {
      const clerk = (globalThis as Record<string, unknown>)["Clerk"] as
        | { session?: { getToken?: () => Promise<string | null> } }
        | undefined;
      token = (await clerk?.session?.getToken?.()) ?? "";
    } catch (error) {
      console.warn("Failed to get Clerk session token:", error);
    }

    const meta = this.auth.profileMeta();
    const redirectParams = new URLSearchParams({
      userId: this.auth.userId() ?? "",
      email: this.auth.email() ?? "",
      displayName: this.auth.displayName() ?? "",
      avatarUrl: this.auth.avatarUrl() ?? "",
      school: meta.school,
      major: meta.major,
      country: meta.country,
      bio: meta.bio,
      leaderboardVisibility: meta.leaderboardVisibility,
      token
    });

    globalThis.location.href = `${scheme}://auth?${redirectParams.toString()}`;
  }

  // ───────────────────── Monitoring ─────────────────────

  private async startMonitoring() {
    this.isBusy.set(true);
    this.micError.set(null);
    this.statusMessage.set("Opening microphone");
    this.activeTab.set("live");
    this.isCorrectionOpen.set(false);

    try {
      const userId = this.auth.userId() ?? undefined;
      const sessionId = await this.socketService.startSession(this.deviceId, this.selectedMode(), userId);
      this.sessionId.set(sessionId);
      this.sessionStartedAtMs.set(Date.now());
      this.transcriptSegments.set([]);
      this.interventions.set([]);
      await this.audioCaptureService.start();
      this.isMonitoring.set(true);

      const modeLabels: Record<SessionMode, string> = {
        debate_live: "Listening for factual claims",
        conversation_score: "Recording — score at end of session",
        silent_review: "Capturing silently — review later",
        background_capture: "Background capture active"
      };
      this.statusMessage.set(modeLabels[this.selectedMode()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start monitoring";
      this.micError.set(message);
      this.statusMessage.set(message.includes("backend") ? "Backend unavailable" : "Microphone unavailable");

      const currentSessionId = this.sessionId();
      if (currentSessionId) {
        await this.socketService.stopSession(currentSessionId);
        this.sessionId.set(null);
      }

      this.sessionStartedAtMs.set(null);
    } finally {
      this.isBusy.set(false);
    }
  }

  protected readonly isProcessingFinal = signal(false);

  private async stopMonitoring() {
    this.isBusy.set(true);
    this.isMonitoring.set(false);
    this.statusMessage.set("Stopping capture");

    // V2: remember which session just ended so the attribution modal
    // can send its result to the right session endpoint.
    const stoppedSessionId = this.sessionId();

    try {
      await this.audioCaptureService.stop();
      const currentSessionId = this.sessionId();

      if (currentSessionId) {
        await this.socketService.stopSession(currentSessionId);

        // Wait for the pipeline to finish processing remaining claims.
        // Pipeline latency: transcription ~3s + detection ~2s + citations ~3s + verification ~3s ≈ 12s
        this.isProcessingFinal.set(true);
        this.statusMessage.set("Processing final claims…");
        this.activeTab.set("insights");

        const interventionCountBefore = this.interventions().length;
        const maxWaitMs = 18_000;
        const pollIntervalMs = 2_000;
        const startedAt = Date.now();

        // Poll: wait up to 18s, stop early if a new intervention arrives
        while (Date.now() - startedAt < maxWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          await this.refreshHistory();

          // If we received new interventions, wait one more cycle then break
          if (this.interventions().length > interventionCountBefore) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            await this.refreshHistory();
            break;
          }
        }

        this.isProcessingFinal.set(false);
      }

      void this.loadSessionTopics();
      void this.loadMonthlyReflection();
      this.statusMessage.set("Session archived");
    } finally {
      this.sessionId.set(null);
      this.sessionStartedAtMs.set(null);
      this.isBusy.set(false);
      this.speakerState.reset();

      // V2: After a debate_live session, prompt the user to identify the
      // opponent so both sides can appear on the leaderboard. Only show
      // this if the session actually produced transcript content (not a
      // cold-boot cancel), and only once per session.
      if (
        stoppedSessionId &&
        this.selectedMode() === "debate_live" &&
        this.transcriptSegments().length > 0 &&
        this.attributionCompletedForSessionId() !== stoppedSessionId
      ) {
        this.openAttributionModal(stoppedSessionId);
      }
    }
  }

  // ───────────────────── V2 attribution flow ─────────────────────

  protected openAttributionModal(sessionId: string) {
    // Stash the sessionId-to-attribute in the "completed" slot (consumed when
    // the user submits or skips).
    this.attributionCompletedForSessionId.set(null);
    this.attributionQuery.set("");
    this.attributionSearchResults.set([]);
    this.attributionError.set(null);
    this.attributionModalOpen.set(true);
    // Stash the session we're attributing via a signal
    this.sessionPendingAttribution.set(sessionId);
  }

  protected closeAttributionModal() {
    this.attributionModalOpen.set(false);
    this.sessionPendingAttribution.set(null);
  }

  protected async onAttributionQueryChange(query: string) {
    this.attributionQuery.set(query);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      this.attributionSearchResults.set([]);
      return;
    }
    try {
      const res = await this.attributionApi.searchUsers(trimmed);
      this.attributionSearchResults.set(res.results);
    } catch (error) {
      console.warn("User search failed:", error);
      this.attributionSearchResults.set([]);
    }
  }

  protected async submitAttributionForUser(userId: string, displayName: string) {
    const sessionId = this.sessionPendingAttribution();
    if (!sessionId) {
      return;
    }
    this.attributionSubmitting.set(true);
    this.attributionError.set(null);
    try {
      await this.attributionApi.attributeSession(sessionId, {
        opponentUserId: userId,
        opponentDisplayName: displayName
      });
      this.attributionCompletedForSessionId.set(sessionId);
      this.closeAttributionModal();
    } catch (error) {
      this.attributionError.set(error instanceof Error ? error.message : "Failed to attribute");
    } finally {
      this.attributionSubmitting.set(false);
    }
  }

  protected async submitAttributionForEmail(email: string) {
    const sessionId = this.sessionPendingAttribution();
    if (!sessionId) {
      return;
    }
    const trimmedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      this.attributionError.set("Enter a valid email address.");
      return;
    }
    this.attributionSubmitting.set(true);
    this.attributionError.set(null);
    try {
      await this.attributionApi.attributeSession(sessionId, { opponentEmail: trimmedEmail });
      this.attributionCompletedForSessionId.set(sessionId);
      this.closeAttributionModal();
    } catch (error) {
      this.attributionError.set(error instanceof Error ? error.message : "Failed to attribute");
    } finally {
      this.attributionSubmitting.set(false);
    }
  }

  protected skipAttribution() {
    const sessionId = this.sessionPendingAttribution();
    if (sessionId) {
      this.attributionCompletedForSessionId.set(sessionId);
    }
    this.closeAttributionModal();
  }

  // Signal holding the session currently queued for attribution.
  private readonly sessionPendingAttribution = signal<string | null>(null);

  private async refreshHistory() {
    const currentSessionId = this.sessionId();
    if (!currentSessionId) {
      return;
    }

    const history = await this.historyApi.getInterventions(currentSessionId);
    this.interventions.set(history.interventions as InterventionMessage[]);
  }

  private formatDurationLabel() {
    const segments = this.transcriptSegments();
    if (segments.length === 0) {
      return "0m 00s";
    }

    const startedAt = Date.parse(segments[0]?.startedAt ?? "");
    const endedAt = this.isMonitoring()
      ? Date.now()
      : Date.parse(segments[segments.length - 1]?.endedAt ?? "");

    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
      return "0m 00s";
    }

    const durationMs = Math.max(0, endedAt - startedAt);
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.floor((durationMs % 60_000) / 1000);
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  private ensureDeviceId() {
    const storageKey = "real-talk-device-id";
    const existing = globalThis.localStorage?.getItem(storageKey);

    if (existing) {
      return existing;
    }

    // Migrate from old key
    const legacy = globalThis.localStorage?.getItem("project-veritas-device-id");
    if (legacy) {
      globalThis.localStorage?.setItem(storageKey, legacy);
      return legacy;
    }

    const next = crypto.randomUUID();
    globalThis.localStorage?.setItem(storageKey, next);
    return next;
  }

  // ───────────────────── V2 Voice enrollment ─────────────────────
  //
  // Records a ~10-second sample of the user's voice and uploads it to the
  // data service. Stored as raw PCM16 base64 for future auto-diarization.
  // We pause any active debate session first to avoid collision.

  protected async startVoiceEnrollment() {
    const userId = this.auth.userId();
    if (!userId) {
      this.micError.set("Sign in to enroll your voice.");
      return;
    }
    if (this.isMonitoring()) {
      this.micError.set("Stop the current session before enrolling.");
      return;
    }
    if (this.voiceEnrollmentState() !== "idle" && this.voiceEnrollmentState() !== "enrolled") {
      return;
    }

    this.voiceEnrollmentState.set("recording");
    this.voiceEnrollmentCountdown.set(10);
    this.micError.set(null);

    // Collect chunks emitted by audio-capture while we're recording
    const collectedChunks: string[] = [];
    const subscription = this.audioCaptureService.chunks$.subscribe((chunk) => {
      // chunk.pcm16Mono is a base64 string of a 4s window.
      // For enrollment we concatenate the first 3 chunks (≈10s of speech).
      if (collectedChunks.length < 3) {
        collectedChunks.push(chunk.pcm16Mono);
      }
    });

    try {
      await this.audioCaptureService.start();

      // Countdown tick
      const countdownInterval = globalThis.setInterval(() => {
        const next = this.voiceEnrollmentCountdown() - 1;
        this.voiceEnrollmentCountdown.set(Math.max(0, next));
      }, 1000);

      // Wait 10 seconds, then stop.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10_000));
      globalThis.clearInterval(countdownInterval);

      await this.audioCaptureService.stop();
      subscription.unsubscribe();

      if (collectedChunks.length === 0) {
        this.voiceEnrollmentState.set("idle");
        this.micError.set("No audio captured — try again.");
        return;
      }

      this.voiceEnrollmentState.set("uploading");

      // Concatenate base64 PCM payloads by decoding, concatenating, re-encoding.
      // Simpler: just send all three concatenated — the server can decode and merge.
      // For now, send the FIRST chunk (4s is enough of a voice sample for V2; the
      // auto-diarization model can enroll from even 1–2s of speech).
      const firstChunk = collectedChunks[0] ?? "";
      await this.attributionApi.submitVoiceEnrollment({
        userId,
        durationMs: 4000,
        sampleRate: 16000,
        pcm16MonoBase64: firstChunk
      });

      this.voiceEnrollmentState.set("enrolled");
    } catch (error) {
      subscription.unsubscribe();
      try {
        await this.audioCaptureService.stop();
      } catch {
        // already stopped
      }
      this.voiceEnrollmentState.set("idle");
      this.micError.set(error instanceof Error ? error.message : "Voice enrollment failed.");
    }
  }
}
