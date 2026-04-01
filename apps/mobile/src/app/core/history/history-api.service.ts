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

function resolveHistoryUrl(): string {
  if (environment.historyUrl) {
    return environment.historyUrl;
  }

  const globalOverride = (globalThis as typeof globalThis & { __VERITAS_HISTORY_URL__?: string }).__VERITAS_HISTORY_URL__;
  if (globalOverride) {
    return globalOverride;
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
}
