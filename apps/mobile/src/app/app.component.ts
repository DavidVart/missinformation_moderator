import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from "@angular/core";
// FormsModule no longer needed — Clerk handles its own UI
import { IonApp, IonIcon, IonSpinner } from "@ionic/angular/standalone";
import { addIcons } from "ionicons";
import {
  analyticsOutline,
  archiveOutline,
  barChartOutline,
  checkmarkCircleOutline,
  closeOutline,
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
import { AudioCaptureService } from "./core/audio/audio-capture.service";
import { AuthService } from "./core/auth/auth.service";
import { HistoryApiService } from "./core/history/history-api.service";
import { MonitoringSocketService } from "./core/monitoring/monitoring-socket.service";
import { SpeechService } from "./core/speech/speech.service";

type AppTab = "live" | "insights" | "rankings" | "profile";

type RankingsSubTab = "global" | "schools" | "majors";

type InsightsSubTab = "session" | "topics" | "trends";

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
  private readonly subscriptions = new Subscription();

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

  protected readonly latestIntervention = computed(() => this.interventions()[0] ?? null);
  protected readonly hasSessionData = computed(() => this.transcriptSegments().length > 0 || this.interventions().length > 0);
  protected readonly showCorrectionOverlay = computed(
    () => (this.activeTab() === "live" || this.activeTab() === "insights") && this.isCorrectionOpen() && !!this.latestIntervention()
  );
  protected readonly transcriptFeed = computed(() => this.transcriptSegments().slice(-8));
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
  protected readonly densityBars = computed(() => {
    const activityBoost = clamp(
      0.24 + this.transcriptSegments().length * 0.03 + this.interventions().length * 0.12,
      0.22,
      0.92
    );

    return buildMeterBars(7, this.ambientTick() * 0.86, activityBoost, 20, 78);
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
        this.statusMessage.set("Correction ready");
        this.isCorrectionOpen.set(true);

        // Auto-dismiss after 12 seconds so the overlay doesn't block forever
        setTimeout(() => {
          if (this.latestIntervention()?.messageId === message.messageId) {
            this.isCorrectionOpen.set(false);
          }
        }, 12_000);

        void this.refreshHistory();
      })
    );

    this.subscriptions.add(
      this.audioCaptureService.levels$.subscribe((level) => {
        this.activityLevel.set(level);
      })
    );

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
      const reflection = await this.analyticsApi.getMonthlyReflection(this.currentReflectionMonth());
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

  // ───────────────────── Monitoring ─────────────────────

  private async startMonitoring() {
    this.isBusy.set(true);
    this.micError.set(null);
    this.statusMessage.set("Opening microphone");
    this.activeTab.set("live");
    this.isCorrectionOpen.set(false);

    try {
      const sessionId = await this.socketService.startSession(this.deviceId);
      this.sessionId.set(sessionId);
      this.sessionStartedAtMs.set(Date.now());
      this.transcriptSegments.set([]);
      this.interventions.set([]);
      await this.audioCaptureService.start();
      this.isMonitoring.set(true);
      this.statusMessage.set("Listening for factual claims");
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
    }
  }

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
}
