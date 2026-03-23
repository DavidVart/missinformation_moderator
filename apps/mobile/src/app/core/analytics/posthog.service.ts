import { Injectable } from "@angular/core";
import posthog from "posthog-js";
import { environment } from "../../../environments/environment";

@Injectable({ providedIn: "root" })
export class PosthogService {
  private initialized = false;

  init() {
    if (this.initialized || !environment.posthogKey) {
      return;
    }

    posthog.init(environment.posthogKey, {
      api_host: environment.posthogHost || "https://us.i.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: true,
      persistence: "localStorage"
    });

    this.initialized = true;
  }

  identify(userId: string, properties?: Record<string, unknown>) {
    if (!this.initialized) {
      return;
    }
    posthog.identify(userId, properties);
  }

  capture(event: string, properties?: Record<string, unknown>) {
    if (!this.initialized) {
      return;
    }
    posthog.capture(event, properties);
  }

  reset() {
    if (!this.initialized) {
      return;
    }
    posthog.reset();
  }
}
