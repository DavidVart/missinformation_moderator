import { Injectable } from "@angular/core";
import { environment } from "../../../environments/environment";

type SessionSummaryResponse = {
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

type SessionListResponse = {
  sessions: SessionSummaryResponse[];
  total: number;
};

type InterventionHistoryResponse = {
  interventions: Array<{
    messageId: string;
    claimId: string;
    verdict: string;
    confidence: number;
    correction: string;
    issuedAt: string;
    attributedTo: "self" | "opponent" | "unknown";
    claimText: string;
    sources: Array<{
      title: string;
      url: string;
      snippet: string;
      publishedAt: string | null;
      sourceType: string;
    }>;
  }>;
};

type SessionDetailResponse = {
  session: {
    session_id: string;
    device_id: string;
    user_id: string | null;
    mode: string;
    status: string;
    started_at: string;
    stopped_at: string | null;
    chunk_ms: number;
    sample_rate: number;
  };
  transcript: Array<{
    segmentId: string;
    deviceId: string;
    userId: string | null;
    mode: string;
    seq: number;
    text: string;
    startedAt: string;
    endedAt: string;
    speakerLabel: string | null;
    speakerId: string | null;
    confidence: number | null;
  }>;
};

function isCapacitorNative(): boolean {
  const cap = (globalThis as Record<string, unknown>)["Capacitor"] as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

function resolveHistoryUrl(): string {
  if (environment.historyUrl) {
    return environment.historyUrl;
  }

  const globalOverride = (globalThis as typeof globalThis & { __VERITAS_HISTORY_URL__?: string }).__VERITAS_HISTORY_URL__;
  if (globalOverride) {
    return globalOverride;
  }

  if (isCapacitorNative()) {
    return "https://real-talk-data.onrender.com/api/history";
  }

  const defaultHost = globalThis.location?.hostname || "localhost";
  return `http://${defaultHost}:4004/api/history`;
}

@Injectable({ providedIn: "root" })
export class HistoryApiService {
  private readonly baseUrl = resolveHistoryUrl();

  async listSessions(params: { userId?: string; deviceId?: string; limit?: number; offset?: number }): Promise<SessionListResponse> {
    const query = new URLSearchParams();
    if (params.userId) query.set("userId", params.userId);
    if (params.deviceId) query.set("deviceId", params.deviceId);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));

    const response = await fetch(`${this.baseUrl}/sessions?${query.toString()}`);

    if (!response.ok) {
      throw new Error(`History list request failed with status ${response.status}`);
    }

    return response.json() as Promise<SessionListResponse>;
  }

  async getInterventions(sessionId: string): Promise<InterventionHistoryResponse> {
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/interventions`);

    if (!response.ok) {
      throw new Error(`History request failed with status ${response.status}`);
    }

    return response.json() as Promise<InterventionHistoryResponse>;
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}`);

    if (!response.ok) {
      throw new Error(`Session detail request failed with status ${response.status}`);
    }

    return response.json() as Promise<SessionDetailResponse>;
  }
}
