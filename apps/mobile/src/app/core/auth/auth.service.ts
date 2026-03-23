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
      await this.clerk.load();
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

  async openSignIn() {
    if (!this.clerk) {
      return;
    }

    this.clerk.openSignIn({});
  }

  async openSignUp() {
    if (!this.clerk) {
      return;
    }

    this.clerk.openSignUp({});
  }

  async openUserProfile() {
    if (!this.clerk) {
      return;
    }
    this.clerk.openUserProfile();
  }

  async signOut() {
    if (!this.clerk) {
      return;
    }

    await this.clerk.signOut();
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
