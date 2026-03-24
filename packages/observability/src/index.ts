import * as Sentry from "@sentry/node";
import type { RequestHandler } from "express";
import pino from "pino";

export { Sentry };

/**
 * Initialize Sentry for a backend service.
 * Call this at the very top of each service's bootstrap, before any other imports if possible.
 */
export function initSentry(serviceName: string, dsn?: string) {
  const sentryDsn = dsn ?? process.env.SENTRY_DSN;
  if (!sentryDsn) return;

  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV ?? "development",
    serverName: serviceName,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    integrations: [Sentry.httpIntegration(), Sentry.expressIntegration()]
  });

  Sentry.setTag("service", serviceName);
}

export function createLogger(serviceName: string, level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    level,
    base: {
      service: serviceName
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

export function createHttpLogger(serviceName: string, level = process.env.LOG_LEVEL ?? "info"): RequestHandler {
  const logger = createLogger(serviceName, level);
  return (request, response, next) => {
    const startedAt = Date.now();

    response.on("finish", () => {
      logger.info(
        {
          method: request.method,
          url: request.originalUrl,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt
        },
        "request completed"
      );
    });

    next();
  };
}
