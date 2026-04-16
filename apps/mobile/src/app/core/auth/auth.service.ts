import { Injectable, signal, computed } from "@angular/core";
import { Clerk } from "@clerk/clerk-js";
import { Browser } from "@capacitor/browser";
import { App as CapApp, type URLOpenListenerEvent } from "@capacitor/app";
import { Preferences } from "@capacitor/preferences";
import { environment } from "../../../environments/environment";

/** Detect Capacitor native runtime via the injected Capacitor global. */
function isCapacitorNative(): boolean {
  const cap = (globalThis as Record<string, unknown>)["Capacitor"] as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

/** Vercel-hosted URL where Clerk auth works natively over HTTPS. */
const HOSTED_AUTH_BASE = "https://missinformation-moderator.vercel.app";

/** Custom URL scheme registered with iOS for deep-link auth callbacks. */
const NATIVE_URL_SCHEME = "com.realtalk.mobile";
const NATIVE_AUTH_CALLBACK_PREFIX = `${NATIVE_URL_SCHEME}://auth`;

/** Preferences keys for persisting auth state across app launches. */
const STORAGE_KEY_USER = "rt.auth.user";
const STORAGE_KEY_TOKEN = "rt.auth.token";

type ClerkUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
  imageUrl: string;
  unsafeMetadata: Record<string, unknown>;
};

export type UserProfileMeta = {
  school: string;
  major: string;
  bio: string;
  country: string;
  leaderboardVisibility: "public" | "private";
};

@Injectable({ providedIn: "root" })
export class AuthService {
  private clerk: Clerk | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly _isReady = signal(false);
  private readonly _user = signal<ClerkUser | null>(null);
  /** True when Clerk init failed (e.g. Capacitor scheme doesn't support cookies). */
  private readonly _clerkUnavailable = signal(false);
  /** Bearer token (Clerk JWT) for authenticating API calls from native. */
  private authToken: string | null = null;

  readonly isReady = this._isReady.asReadonly();
  readonly isSignedIn = computed(() => !!this._user());
  readonly currentUser = this._user.asReadonly();
  readonly displayName = computed(() => {
    const user = this._user();
    if (!user) {
      return "Guest";
    }
    return user.fullName || user.firstName || user.primaryEmailAddress?.emailAddress?.split("@")[0] || "User";
  });
  readonly email = computed(() => this._user()?.primaryEmailAddress?.emailAddress ?? null);
  readonly avatarUrl = computed(() => this._user()?.imageUrl ?? null);
  readonly userId = computed(() => this._user()?.id ?? null);
  readonly profileMeta = computed<UserProfileMeta>(() => {
    const meta = this._user()?.unsafeMetadata ?? {};
    return {
      school: typeof meta["school"] === "string" ? meta["school"] : "",
      major: typeof meta["major"] === "string" ? meta["major"] : "",
      bio: typeof meta["bio"] === "string" ? meta["bio"] : "",
      country: typeof meta["country"] === "string" ? meta["country"] : "",
      leaderboardVisibility: meta["leaderboardVisibility"] === "public" ? "public" : "private"
    };
  });

  async init() {
    const clerkKey = environment.clerkPublishableKey ||
      (isCapacitorNative() ? "pk_test_aHVtYW5lLXdhcnRob2ctNjcuY2xlcmsuYWNjb3VudHMuZGV2JA" : "");

    if (!clerkKey || this.clerk || this._isReady()) {
      return;
    }

    // NATIVE: Skip Clerk JS (doesn't work in capacitor:// due to no cookies).
    // Instead, restore persisted user from Preferences and register the
    // deep-link listener so we can receive session handoffs from the Vercel
    // web app (see openSignIn → Safari → Clerk → deep-link back).
    if (isCapacitorNative()) {
      this._clerkUnavailable.set(true);
      await this.restoreNativeSession();
      await this.registerDeepLinkListener();
      this._isReady.set(true);
      return;
    }

    // WEB: Normal Clerk JS initialization.
    try {
      this.clerk = new Clerk(clerkKey);
      this.loadPromise = this.clerk.load();
      await this.loadPromise;
      this.syncUser();

      // Listen for session changes
      this.clerk.addListener(() => {
        this.syncUser();
      });

      this._isReady.set(true);
    } catch (error) {
      console.error("Clerk initialization failed:", error);
      this._clerkUnavailable.set(true);
      this._isReady.set(true);
    }
  }

  /** Wait for Clerk to be fully loaded (including UI components) before proceeding. */
  private async waitForReady(): Promise<Clerk | null> {
    if (this.loadPromise) {
      await this.loadPromise;
    }
    return this.clerk;
  }

  async openSignIn() {
    // Native (or Clerk-failed): open Vercel handoff page in system browser.
    // The web app there handles the Clerk flow and redirects back to us via
    // the com.realtalk.mobile:// URL scheme with the user info + token.
    if (isCapacitorNative() || this._clerkUnavailable()) {
      await this.openBrowserHandoff();
      return;
    }

    const clerk = await this.waitForReady();
    if (!clerk) {
      return;
    }

    try {
      clerk.openSignIn({});
    } catch (error) {
      console.warn("Clerk openSignIn failed, falling back to redirect:", error);
      clerk.redirectToSignIn();
    }
  }

  async openSignUp() {
    if (isCapacitorNative() || this._clerkUnavailable()) {
      await this.openBrowserHandoff();
      return;
    }

    const clerk = await this.waitForReady();
    if (!clerk) {
      return;
    }

    try {
      clerk.openSignUp({});
    } catch (error) {
      console.warn("Clerk openSignUp failed, falling back to redirect:", error);
      clerk.redirectToSignUp();
    }
  }

  async openUserProfile() {
    if (isCapacitorNative() || this._clerkUnavailable()) {
      // Open the web profile editor — in-app editing requires Clerk JS which
      // doesn't work in Capacitor.
      try {
        await Browser.open({ url: `${HOSTED_AUTH_BASE}/?tab=profile`, presentationStyle: "popover" });
      } catch (error) {
        console.error("Failed to open browser for profile:", error);
      }
      return;
    }

    const clerk = await this.waitForReady();
    if (!clerk) {
      return;
    }

    try {
      clerk.openUserProfile();
    } catch (error) {
      console.warn("Clerk openUserProfile failed:", error);
    }
  }

  async updateProfileMeta(updates: Partial<UserProfileMeta>) {
    // Native: optimistic local update (persisted), no Clerk round-trip.
    if (isCapacitorNative() || this._clerkUnavailable()) {
      const current = this._user();
      if (!current) {
        return;
      }
      const nextMeta = { ...current.unsafeMetadata, ...updates };
      const next: ClerkUser = { ...current, unsafeMetadata: nextMeta };
      this._user.set(next);
      await Preferences.set({ key: STORAGE_KEY_USER, value: JSON.stringify(next) });
      return;
    }

    const clerkUser = this.clerk?.user;
    if (!clerkUser) {
      return;
    }

    const current = clerkUser.unsafeMetadata ?? {};
    await clerkUser.update({
      unsafeMetadata: { ...current, ...updates }
    });
    this.syncUser();
  }

  async signOut() {
    if (isCapacitorNative() || this._clerkUnavailable()) {
      this._user.set(null);
      this.authToken = null;
      await Preferences.remove({ key: STORAGE_KEY_USER });
      await Preferences.remove({ key: STORAGE_KEY_TOKEN });
      return;
    }

    const clerk = await this.waitForReady();
    if (!clerk) {
      return;
    }

    await clerk.signOut();
    this._user.set(null);
  }

  /** Bearer token for authenticated API calls (currently only set in native). */
  getAuthToken(): string | null {
    return this.authToken;
  }

  // ─── Native deep-link handoff ────────────────────────────────────────────

  private async openBrowserHandoff() {
    const url = `${HOSTED_AUTH_BASE}/?mobileAuth=1&scheme=${encodeURIComponent(NATIVE_URL_SCHEME)}`;
    try {
      await Browser.open({ url, presentationStyle: "popover" });
    } catch (error) {
      console.error("Failed to open browser for auth:", error);
    }
  }

  private async registerDeepLinkListener() {
    try {
      await CapApp.addListener("appUrlOpen", (event: URLOpenListenerEvent) => {
        void this.handleDeepLink(event.url);
      });
    } catch (error) {
      console.error("Failed to register deep link listener:", error);
    }
  }

  private async handleDeepLink(url: string) {
    if (!url || !url.startsWith(NATIVE_AUTH_CALLBACK_PREFIX)) {
      return;
    }

    // Parse the deep-link URL. iOS delivers URLs with the scheme in place,
    // but URL parsing with a custom scheme is flaky on some runtimes — so
    // replace the scheme with https:// for parsing, which is safe since we
    // only care about search params.
    const parseableUrl = url.replace(/^com\.realtalk\.mobile:\/\//, "https://dummy.local/");
    let params: URLSearchParams;
    try {
      params = new URL(parseableUrl).searchParams;
    } catch (error) {
      console.error("Failed to parse deep link URL:", url, error);
      return;
    }

    const userId = params.get("userId");
    if (!userId) {
      console.warn("Deep link auth callback missing userId:", url);
      return;
    }

    const email = params.get("email") || "";
    const displayName = params.get("displayName") || "";
    const avatarUrl = params.get("avatarUrl") || "";
    const token = params.get("token");
    const school = params.get("school") || "";
    const major = params.get("major") || "";
    const country = params.get("country") || "";
    const bio = params.get("bio") || "";
    const leaderboardVisibility = params.get("leaderboardVisibility") === "public" ? "public" : "private";

    const user: ClerkUser = {
      id: userId,
      firstName: null,
      lastName: null,
      fullName: displayName || null,
      primaryEmailAddress: email ? { emailAddress: email } : null,
      imageUrl: avatarUrl,
      unsafeMetadata: { school, major, country, bio, leaderboardVisibility }
    };

    this._user.set(user);
    this.authToken = token;

    // Persist so the user stays signed in across app launches.
    try {
      await Preferences.set({ key: STORAGE_KEY_USER, value: JSON.stringify(user) });
      if (token) {
        await Preferences.set({ key: STORAGE_KEY_TOKEN, value: token });
      }
    } catch (error) {
      console.warn("Failed to persist auth state:", error);
    }

    // Close the in-app browser so the user returns to the app.
    try {
      await Browser.close();
    } catch {
      // Browser may already be closed — no-op.
    }
  }

  private async restoreNativeSession() {
    try {
      const userJson = await Preferences.get({ key: STORAGE_KEY_USER });
      if (userJson.value) {
        const user = JSON.parse(userJson.value) as ClerkUser;
        this._user.set(user);
      }
      const tokenRes = await Preferences.get({ key: STORAGE_KEY_TOKEN });
      this.authToken = tokenRes.value ?? null;
    } catch (error) {
      console.warn("Failed to restore native session:", error);
    }
  }

  private syncUser() {
    const clerkUser = this.clerk?.user;
    if (clerkUser) {
      this._user.set({
        id: clerkUser.id,
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        fullName: clerkUser.fullName,
        primaryEmailAddress: clerkUser.primaryEmailAddress
          ? { emailAddress: clerkUser.primaryEmailAddress.emailAddress }
          : null,
        imageUrl: clerkUser.imageUrl,
        unsafeMetadata: (clerkUser.unsafeMetadata ?? {}) as Record<string, unknown>
      });
    } else {
      this._user.set(null);
    }
  }
}
