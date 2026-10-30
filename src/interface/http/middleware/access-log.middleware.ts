import type { NextFunction, Request, Response } from 'express';
import { Logger } from '../../../application/ports/Logger.js';

const QUIET_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

export function accessLogMiddleware(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      const path = request.path;
      const fields = {
        method: request.method,
        path,
        status: response.statusCode,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
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
