import { Injectable } from "@angular/core";
import { environment } from "../../../environments/environment";

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

  async getInterventions(sessionId: string): Promise<InterventionHistoryResponse> {
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/interventions`);

    if (!response.ok) {
      throw new Error(`History request failed with status ${response.status}`);
    }

    return response.json() as Promise<InterventionHistoryResponse>;
  }
}
