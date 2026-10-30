import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../../../infrastructure/observability/request-context.js';

export const CORRELATION_HEADER = 'x-correlation-id';
const ACCEPTED = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestContextMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.header(CORRELATION_HEADER);
  const correlationId =
    incoming && ACCEPTED.test(incoming) ? incoming : randomUUID();
  response.setHeader(CORRELATION_HEADER, correlationId);
  requestContext.run({ correlationId }, next);
}
