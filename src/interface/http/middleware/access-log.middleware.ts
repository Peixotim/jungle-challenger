import type { NextFunction, Request, Response } from 'express';
import { Logger } from '../../../application/ports/Logger.js';
import { Metrics } from '../../../application/ports/Metrics.js';

const QUIET_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);
const UNMATCHED_ROUTE = 'unmatched';

export function accessLogMiddleware(logger: Logger, metrics: Metrics) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      const path = request.path;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const route = (request.route as { path?: string } | undefined)?.path;

      const labels = {
        method: request.method,
        route: route ?? UNMATCHED_ROUTE,
      };
      metrics.increment('http_requests_total', {
        ...labels,
        status: String(response.statusCode),
      });
      metrics.observe(
        'http_request_duration_seconds',
        durationMs / 1000,
        labels,
      );

      const fields = {
        method: request.method,
        path,
        status: response.statusCode,
        durationMs,
        contentLength:
          Number(response.getHeader('content-length')) || undefined,
      };
      if (QUIET_PATHS.has(path) && response.statusCode < 500)
        logger.debug('http request', fields);
      else logger.info('http request', fields);
    });
    next();
  };
}
