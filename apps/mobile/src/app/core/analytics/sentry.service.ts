import { ErrorHandler, Injectable } from "@angular/core";
import * as Sentry from "@sentry/angular";
import { environment } from "../../../environments/environment";

export function initSentry() {
  if (!environment.sentryDsn) {
    return;
  }

  Sentry.init({
    dsn: environment.sentryDsn,
    environment: environment.production ? "production" : "development",
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false })
    ],
    tracesSampleRate: environment.production ? 0.2 : 1.0,
    replaysSessionSampleRate: environment.production ? 0.1 : 0,
    replaysOnErrorSampleRate: 1.0
  });
}

@Injectable()
export class SentryErrorHandler implements ErrorHandler {
  handleError(error: unknown) {
    if (environment.sentryDsn) {
      Sentry.captureException(error);
    }
    console.error(error);
  }
}
