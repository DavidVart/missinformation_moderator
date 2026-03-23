import { initSentry } from "./app/core/analytics/sentry.service";

// Initialize Sentry before Angular boots
initSentry();

import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";

bootstrapApplication(AppComponent, appConfig).catch((error) => {
  console.error(error);
});
