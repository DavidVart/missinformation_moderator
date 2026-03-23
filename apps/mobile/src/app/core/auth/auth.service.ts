import { Injectable, inject, signal, computed } from "@angular/core";
import { IdentityApiService, UserInfo, UserProfile } from "./identity-api.service";

type AuthState =
  | { status: "signed-out" }
  | { status: "awaiting-code"; email: string }
  | { status: "verifying" }
  | { status: "signed-in"; accessToken: string; user: UserInfo; profile: UserProfile };

const STORAGE_KEY = "real-talk-auth";

@Injectable({ providedIn: "root" })
export class AuthService {
  private readonly identityApi = inject(IdentityApiService);
  private readonly state = signal<AuthState>(this.restoreSession());

  readonly authState = this.state.asReadonly();
  readonly isSignedIn = computed(() => this.state().status === "signed-in");
  readonly currentUser = computed(() => {
    const s = this.state();
    return s.status === "signed-in" ? s.user : null;
  });
  readonly currentProfile = computed(() => {
    const s = this.state();
    return s.status === "signed-in" ? s.profile : null;
  });
  readonly accessToken = computed(() => {
    const s = this.state();
    return s.status === "signed-in" ? s.accessToken : null;
  });

  private getDeviceId(): string {
    const key = "real-talk-device-id";
    let id = globalThis.localStorage?.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      globalThis.localStorage?.setItem(key, id);
    }
    return id;
  }

  async requestMagicLink(email: string): Promise<{ previewCode?: string }> {
    const result = await this.identityApi.startMagicLink(email, this.getDeviceId());
    this.state.set({ status: "awaiting-code", email });
    return { previewCode: result.previewCode };
  }

  async verifyCode(code: string): Promise<void> {
    const current = this.state();
    if (current.status !== "awaiting-code") {
      throw new Error("No pending magic link to verify");
    }

    this.state.set({ status: "verifying" });

    try {
      const result = await this.identityApi.verifyMagicLink(current.email, code, this.getDeviceId());
      const signedIn: AuthState = {
        status: "signed-in",
        accessToken: result.accessToken,
        user: result.user,
        profile: result.profile
      };
      this.state.set(signedIn);
      this.persistSession(signedIn);
    } catch (error) {
      this.state.set({ status: "awaiting-code", email: current.email });
      throw error;
    }
  }

  async refreshProfile(): Promise<void> {
    const token = this.accessToken();
    if (!token) {
      return;
    }

    try {
      const profile = await this.identityApi.getProfile(token);
      const current = this.state();
      if (current.status === "signed-in") {
        const updated: AuthState = { ...current, profile };
        this.state.set(updated);
        this.persistSession(updated);
      }
    } catch {
      // Token may have expired — sign out
      this.signOut();
    }
  }

  signOut() {
    this.state.set({ status: "signed-out" });
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  }

  cancelMagicLink() {
    this.state.set({ status: "signed-out" });
  }

  private persistSession(state: AuthState) {
    if (state.status !== "signed-in") {
      return;
    }
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      accessToken: state.accessToken,
      user: state.user,
      profile: state.profile
    }));
  }

  private restoreSession(): AuthState {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) {
        return { status: "signed-out" };
      }
      const data = JSON.parse(raw) as { accessToken: string; user: UserInfo; profile: UserProfile };
      if (data.accessToken && data.user && data.profile) {
        return {
          status: "signed-in",
          accessToken: data.accessToken,
          user: data.user,
          profile: data.profile
        };
      }
    } catch {
      // Corrupted storage — ignore
    }
    return { status: "signed-out" };
  }
}
