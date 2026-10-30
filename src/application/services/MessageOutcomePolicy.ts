import { IdempotencyConflictError } from '../errors/application-errors.js';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  InvalidTransactionError,
  InvalidWalletError,
} from '../../domain/errors/domain-errors.js';

export type DeadLetterReason =
  'MALFORMED' | 'INVALID' | 'CONFLICT' | 'RETRIES_EXHAUSTED';

export type MessageAction =
  | { kind: 'ack' }
  | { kind: 'retry'; delaySeconds: number }
  | { kind: 'dead-letter'; reason: DeadLetterReason };

export interface MessageOutcomeOptions {
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export class MessageOutcomePolicy {
  constructor(private readonly options: MessageOutcomeOptions) {}

  decide(error: unknown, receiveCount: number): MessageAction {
    if (error instanceof IdempotencyConflictError) {
      return { kind: 'dead-letter', reason: 'CONFLICT' };
    }
    if (
      error instanceof InvalidMoneyError ||
      error instanceof InvalidTransactionError ||
      error instanceof InvalidWalletError ||
      error instanceof CurrencyMismatchError
    ) {
      return { kind: 'dead-letter', reason: 'INVALID' };
    }
    if (receiveCount >= this.options.maxAttempts) {
      return { kind: 'dead-letter', reason: 'RETRIES_EXHAUSTED' };
    }
    return { kind: 'retry', delaySeconds: this.backoffSeconds(receiveCount) };
  }

  backoffSeconds(receiveCount: number): number {
    const { retryBaseSeconds, retryMaxSeconds } = this.options;
    const exponent = Math.max(0, receiveCount - 1);
    return Math.min(retryMaxSeconds, retryBaseSeconds * 2 ** exponent);
  }
}
