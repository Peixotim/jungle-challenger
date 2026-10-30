import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import { mapKnownError } from './error-mapping.js';

export interface ProblemFieldError {
  path: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: ProblemFieldError[];
  correlationId?: string;
}

export function problemFor(
  status: number,
  code?: string,
  detail?: string,
  errors?: ProblemFieldError[],
): Problem {
  return {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    code: code ?? codeForStatus(status),
    ...(detail ? { detail } : {}),
    ...(errors?.length ? { errors } : {}),
  };
}

export function toProblem(exception: unknown, correlationId?: string): Problem {
  const problem = classify(exception);
  return correlationId ? { ...problem, correlationId } : problem;
}

function classify(exception: unknown): Problem {
  if (!(exception instanceof HttpException)) {
    const known = mapKnownError(exception);
    return known
      ? problemFor(known.status, known.code, known.detail)
      : problemFor(500, 'INTERNAL_ERROR');
  }
  const status = exception.getStatus();
  if (status >= 500) return problemFor(status, 'INTERNAL_ERROR');

  const response = exception.getResponse();
  if (typeof response === 'string')
    return problemFor(status, undefined, response);
  const { code, message, errors } = response as {
    code?: unknown;
    message?: string | string[];
    errors?: ProblemFieldError[];
  };
  return problemFor(
    status,
    typeof code === 'string' ? code : undefined,
    Array.isArray(message) ? message.join('; ') : message,
    errors,
  );
}

function codeForStatus(status: number): string {
  return (STATUS_CODES[status] ?? 'ERROR')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}
