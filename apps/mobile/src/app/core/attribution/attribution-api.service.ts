import { Injectable } from "@angular/core";
import type {
  SessionAttributionResponse,
  UserSearchResponse,
  VoiceEnrollmentPayload,
  VoiceEnrollmentResponse
} from "@project-veritas/contracts";
import { environment } from "../../../environments/environment";

function isCapacitorNative(): boolean {
  const cap = (globalThis as Record<string, unknown>)["Capacitor"] as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

function resolveAnalyticsUrl(): string {
  if (environment.analyticsUrl) {
    return environment.analyticsUrl;
  }
  if (isCapacitorNative()) {
    return "https://real-talk-data.onrender.com/api/analytics";
  }
  const defaultHost = globalThis.location?.hostname || "localhost";
  return `http://${defaultHost}:4004/api/analytics`;
}

/**
 * V2 Debate Mode — API calls for opponent attribution, user search,
 * and voice enrollment (saved for future auto-diarization).
 */
@Injectable({ providedIn: "root" })
export class AttributionApiService {
  private readonly baseUrl = resolveAnalyticsUrl();

  /** Search users by display name or email for the post-session attribution modal. */
  async searchUsers(query: string): Promise<UserSearchResponse> {
    const url = `${this.baseUrl}/users/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`User search failed with status ${response.status}`);
    }
    return response.json() as Promise<UserSearchResponse>;
  }

  /** Attribute a finished session to an opponent (by userId or email). */
  async attributeSession(
    sessionId: string,
    input: {
      opponentUserId?: string | undefined;
      opponentEmail?: string | undefined;
      opponentDisplayName?: string | undefined;
    }
  ): Promise<SessionAttributionResponse> {
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/attribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!response.ok) {
      throw new Error(`Attribution failed with status ${response.status}`);
    }
    return response.json() as Promise<SessionAttributionResponse>;
  }

  /** Upload a voice enrollment sample for future auto-diarization. */
  async submitVoiceEnrollment(payload: VoiceEnrollmentPayload): Promise<VoiceEnrollmentResponse> {
    const response = await fetch(`${this.baseUrl}/voice-enrollment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`Voice enrollment failed with status ${response.status}`);
    }
    return response.json() as Promise<VoiceEnrollmentResponse>;
  }
}
