import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import { OptimisticLockError } from './errors.js';

export type TransientKind = 'lock_conflict' | 'unavailable';

const LOCK_CONFLICT_CODES = new Set(['40001', '40P01', '55P03']);
const UNAVAILABLE_CODES = new Set([
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
]);
const UNAVAILABLE_MESSAGES = [
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
];
const MAX_CAUSE_DEPTH = 4;

export function classifyTransient(error: unknown): TransientKind | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (
      current instanceof OptimisticLockError ||
      current instanceof DeadlockException ||
      current instanceof LockWaitTimeoutException
    ) {
      return 'lock_conflict';
    }
    if (current instanceof ConnectionException) return 'unavailable';

    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (LOCK_CONFLICT_CODES.has(code)) return 'lock_conflict';
      if (UNAVAILABLE_CODES.has(code)) return 'unavailable';
    }
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === 'string' &&
      UNAVAILABLE_MESSAGES.some((known) => message.startsWith(known))
    ) {
      return 'unavailable';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
