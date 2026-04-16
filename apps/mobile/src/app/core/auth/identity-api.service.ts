import { Injectable } from "@angular/core";
import { environment } from "../../../environments/environment";

type MagicLinkStartResponse = {
  ok: boolean;
  expiresInMinutes: number;
  previewCode?: string;
};

type MagicLinkVerifyResponse = {
  accessToken: string;
  user: {
    userId: string;
    email: string;
    createdAt: string;
    updatedAt: string;
  };
  profile: {
    userId: string;
    displayName: string;
    avatar: string | null;
    school: string | null;
    major: string | null;
    country: string | null;
    bio: string | null;
    leaderboardVisibility: string;
    createdAt: string;
    updatedAt: string;
  };
};

export type UserProfile = MagicLinkVerifyResponse["profile"];
export type UserInfo = MagicLinkVerifyResponse["user"];

type ProfileGetResponse = UserProfile;

function isCapacitorNative(): boolean {
  const cap = (globalThis as Record<string, unknown>)["Capacitor"] as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

function resolveIdentityUrl(): string {
  if (environment.identityUrl) {
    return environment.identityUrl;
  }

  const globalOverride = (globalThis as typeof globalThis & { __VERITAS_IDENTITY_URL__?: string }).__VERITAS_IDENTITY_URL__;
  if (globalOverride) {
    return globalOverride;
  }

  if (isCapacitorNative()) {
    return "https://real-talk-identity.onrender.com/api/identity";
  }

  const defaultHost = globalThis.location?.hostname || "localhost";
  return `http://${defaultHost}:4005/api/identity`;
}

@Injectable({ providedIn: "root" })
export class IdentityApiService {
  private readonly baseUrl = resolveIdentityUrl();

  async startMagicLink(email: string, deviceId: string): Promise<MagicLinkStartResponse> {
    const response = await fetch(`${this.baseUrl}/auth/magic-link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, deviceId })
    });

    if (!response.ok) {
      throw new Error(`Magic link request failed with status ${response.status}`);
    }

    return response.json() as Promise<MagicLinkStartResponse>;
  }

  async verifyMagicLink(email: string, token: string, deviceId: string): Promise<MagicLinkVerifyResponse> {
    const response = await fetch(`${this.baseUrl}/auth/magic-link/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token, deviceId })
    });

    if (!response.ok) {
      throw new Error(`Magic link verification failed with status ${response.status}`);
    }

    return response.json() as Promise<MagicLinkVerifyResponse>;
  }

  async getProfile(accessToken: string): Promise<ProfileGetResponse> {
    const response = await fetch(`${this.baseUrl}/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      throw new Error(`Profile fetch failed with status ${response.status}`);
    }

    return response.json() as Promise<ProfileGetResponse>;
  }

  async updateProfile(accessToken: string, updates: Partial<Omit<UserProfile, "userId" | "createdAt" | "updatedAt">>): Promise<ProfileGetResponse> {
    const response = await fetch(`${this.baseUrl}/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      throw new Error(`Profile update failed with status ${response.status}`);
    }

    return response.json() as Promise<ProfileGetResponse>;
  }
}
