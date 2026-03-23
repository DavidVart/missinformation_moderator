import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from "@angular/core";
import { IonApp, IonContent, IonIcon, IonSpinner } from "@ionic/angular/standalone";
import { addIcons } from "ionicons";
import {
  analyticsOutline,
  archiveOutline,
  barChartOutline,
  checkmarkCircleOutline,
  closeOutline,
  documentTextOutline,
  flashOutline,
  homeOutline,
  micOutline,
  personOutline,
  pulseOutline,
  personCircleOutline,
  radioButtonOnOutline,
  settingsOutline,
  shieldCheckmarkOutline,
  sparklesOutline,
  stopCircleOutline,
  timeOutline,
  volumeHighOutline,
  warningOutline
} from "ionicons/icons";
import { Subscription } from "rxjs";

import type { InterventionMessage, TranscriptSegment } from "@project-veritas/contracts";

import { AudioCaptureService } from "./core/audio/audio-capture.service";
import { HistoryApiService } from "./core/history/history-api.service";
import { MonitoringSocketService } from "./core/monitoring/monitoring-socket.service";
import { SpeechService } from "./core/speech/speech.service";

type AppTab = "home" | "live" | "insights" | "archive" | "profile";

type FeatureCard = {
  icon: string;
  title: string;
  body: string;
  tone: "soft" | "primary";
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
    IonContent,
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
  private readonly speechService = inject(SpeechService);
  private readonly subscriptions = new Subscription();

  protected readonly isMonitoring = signal(false);
  protected readonly isBusy = signal(false);
  protected readonly sessionId = signal<string | null>(null);
  protected readonly transcriptSegments = signal<TranscriptSegment[]>([]);
  protected readonly interventions = signal<InterventionMessage[]>([]);
  protected readonly statusMessage = signal("Ready to moderate");
  protected readonly micError = signal<string | null>(null);
  protected readonly transportStatus = signal<"connecting" | "connected" | "offline">("connecting");
  protected readonly activeTab = signal<AppTab>("home");
  protected readonly isCorrectionOpen = signal(true);
  protected readonly activityLevel = signal(0);
  protected readonly ambientTick = signal(0);
  protected readonly uiNowMs = signal(Date.now());
  protected readonly sessionStartedAtMs = signal<number | null>(null);

  protected readonly latestIntervention = computed(() => this.interventions()[0] ?? null);
  protected readonly hasSessionData = computed(() => this.transcriptSegments().length > 0 || this.interventions().length > 0);
  protected readonly showCorrectionOverlay = computed(
    () => this.activeTab() === "live" && this.isCorrectionOpen() && !!this.latestIntervention()
  );
  protected readonly transcriptFeed = computed(() => this.transcriptSegments().slice(-8));
  protected readonly archiveFeed = computed(() => this.interventions().slice(0, 8));
  protected readonly recentMoments = computed(() =>
    this.transcriptSegments()
      .slice(-3)
      .map((segment, index) => ({
        id: segment.segmentId,
        title: `Transcript moment ${index + 1}`,
        body: segment.text,
        timestamp: segment.startedAt
      }))
  );
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
  protected readonly homeReadouts = computed<StatusReadout[]>(() => [
    {
      label: "Transport",
      value: this.transportPillLabel(),
      emphasis: this.transportStatus() === "connected"
    },
    {
      label: "Window",
      value: "4s rolling"
    },
    {
      label: "Cadence",
      value: "2s overlap"
    }
  ]);
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
  protected readonly homeWaveBars = computed(() =>
    buildMeterBars(
      15,
      this.ambientTick(),
      this.transportStatus() === "connected" ? 0.42 : 0.26,
      22,
      148
    )
  );
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

  protected readonly featureCards: FeatureCard[] = [
    {
      icon: "shield-checkmark-outline",
      title: "Integrity First",
      body: "Advanced neural patterns detect factual inconsistencies in real-time conversations.",
      tone: "soft"
    },
    {
      icon: "sparkles-outline",
      title: "Neutral Stance",
      body: "Our algorithm maintains zero bias, focusing only on structural logic and verifiable facts.",
      tone: "primary"
    },
    {
      icon: "pulse-outline",
      title: "Deep Listening",
      body: "Sophisticated voice analysis and overlap-aware transcription preserve accountability.",
      tone: "soft"
    }
  ];

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
      barChartOutline,
      checkmarkCircleOutline,
      closeOutline,
      documentTextOutline,
      flashOutline,
      homeOutline,
      micOutline,
      personOutline,
      pulseOutline,
      personCircleOutline,
      radioButtonOnOutline,
      settingsOutline,
      shieldCheckmarkOutline,
      sparklesOutline,
      stopCircleOutline,
      timeOutline,
      volumeHighOutline,
      warningOutline
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
        this.statusMessage.set("Correction ready");
        this.isCorrectionOpen.set(true);
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
    if (tab !== "live") {
      this.isCorrectionOpen.set(false);
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

  protected goLiveAndStart() {
    this.activeTab.set("live");
    void this.startMonitoring();
  }

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

  private async stopMonitoring() {
    this.isBusy.set(true);
    this.statusMessage.set("Stopping session");

    try {
      await this.audioCaptureService.stop();
      const currentSessionId = this.sessionId();

      if (currentSessionId) {
        await this.socketService.stopSession(currentSessionId);
      }

      this.isMonitoring.set(false);
      this.statusMessage.set("Session archived");
      this.activeTab.set("insights");
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
