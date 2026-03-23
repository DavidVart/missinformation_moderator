import { ApplicationConfig, ErrorHandler, provideZoneChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideIonicAngular } from "@ionic/angular/standalone";

import { routes } from "./app.routes";
import { SentryErrorHandler } from "./core/analytics/sentry.service";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideIonicAngular(),
    { provide: ErrorHandler, useClass: SentryErrorHandler }
  ]
};
