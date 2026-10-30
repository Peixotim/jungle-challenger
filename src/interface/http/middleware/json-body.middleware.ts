import { HttpException } from '@nestjs/common';
import express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';

export function jsonBodyParser(limit: string): RequestHandler {
  return express.json({ limit });
}

export const jsonBodyErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  _response,
  next,
) => {
  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    next(
      new HttpException(
        { code: 'MALFORMED_JSON', message: 'request body is not valid JSON' },
        400,
      ),
    );
  } else if (type === 'entity.too.large') {
    next(
      new HttpException(
        { code: 'PAYLOAD_TOO_LARGE', message: 'request body is too large' },
        413,
      ),
    );
  } else {
    next(error);
  }
};
