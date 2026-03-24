import { Injectable, signal, computed } from "@angular/core";
import { Clerk } from "@clerk/clerk-js";
import { environment } from "../../../environments/environment";

type ClerkUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
  imageUrl: string;
};

@Injectable({ providedIn: "root" })
export class AuthService {
  private clerk: Clerk | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly _isReady = signal(false);
  private readonly _user = signal<ClerkUser | null>(null);

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

  async init() {
    if (!environment.clerkPublishableKey || this.clerk) {
      return;
    }

    try {
      this.clerk = new Clerk(environment.clerkPublishableKey);
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
    }
  }

  /** Wait for Clerk to be fully loaded (including UI components) before proceeding. */
  private async waitForReady(): Promise<Clerk | null> {
    if (this.loadPromise) {
      await this.loadPromise;
    }
    return this._isReady() ? this.clerk : null;
  }

  async openSignIn() {
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

  async signOut() {
    const clerk = await this.waitForReady();
    if (!clerk) {
      return;
    }

    await clerk.signOut();
    this._user.set(null);
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
        imageUrl: clerkUser.imageUrl
      });
    } else {
      this._user.set(null);
    }
  }
}
