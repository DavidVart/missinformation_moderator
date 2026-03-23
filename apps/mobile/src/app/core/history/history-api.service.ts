import { Injectable } from "@angular/core";

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

@Injectable({ providedIn: "root" })
export class HistoryApiService {
  private readonly defaultHost = globalThis.location?.hostname || "localhost";
  private readonly baseUrl =
    (globalThis as typeof globalThis & { __VERITAS_HISTORY_URL__?: string }).__VERITAS_HISTORY_URL__ ??
    `http://${this.defaultHost}:4004/api/history`;

  async getInterventions(sessionId: string): Promise<InterventionHistoryResponse> {
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/interventions`);

    if (!response.ok) {
      throw new Error(`History request failed with status ${response.status}`);
    }

    return response.json() as Promise<InterventionHistoryResponse>;
  }
}
