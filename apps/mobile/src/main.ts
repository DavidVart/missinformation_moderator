import { initSentry } from "./app/core/analytics/sentry.service";

// Initialize Sentry before Angular boots
initSentry();

// Mobile auth handoff: when opened from the native app (?mobileAuth=1), add a
// body class BEFORE Angular bootstraps. CSS then hides the full app UI so the
// user only sees a lightweight "Signing you in…" screen (and Clerk's sign-in
// modal on top of it) — not a flash of the main app.
if (typeof document !== "undefined") {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  if (params.get("mobileAuth") === "1") {
    document.documentElement.classList.add("rt-mobile-auth-mode");
  }
}

import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";

bootstrapApplication(AppComponent, appConfig).catch((error) => {
  console.error(error);
});
