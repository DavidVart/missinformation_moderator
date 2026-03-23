import type { RequestHandler } from "express";
import pino from "pino";

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
