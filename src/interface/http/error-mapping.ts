import {
  IdempotencyConflictError,
  InvalidQueryError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors/application-errors.js';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  InvalidTransactionError,
  InvalidWalletError,
} from '../../domain/errors/domain-errors.js';
import { classifyTransient } from '../../infrastructure/persistence/transient-errors.js';

export interface KnownError {
  status: number;
  code: string;
  detail?: string;
}

export function mapKnownError(error: unknown): KnownError | undefined {
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      code: `IDEMPOTENCY_${error.reason}`,
      detail:
        'the idempotency key or provider transaction id was already used by a different request',
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return {
      status: 409,
      code: 'WALLET_ALREADY_EXISTS',
      detail: error.message,
    };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: 404, code: 'WALLET_NOT_FOUND', detail: error.message };
  }
  if (error instanceof TransactionNotFoundError) {
    return {
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
      detail: error.message,
    };
  }
  if (error instanceof InvalidQueryError) {
    return { status: 400, code: 'INVALID_QUERY', detail: error.message };
  }
  if (error instanceof InvalidMoneyError) {
    return { status: 400, code: 'INVALID_MONEY', detail: error.message };
  }
  if (error instanceof CurrencyMismatchError) {
    return { status: 400, code: 'CURRENCY_MISMATCH', detail: error.message };
  }
  if (error instanceof InvalidTransactionError) {
    return { status: 400, code: 'INVALID_TRANSACTION', detail: error.message };
  }
  if (error instanceof InvalidWalletError) {
    return { status: 400, code: 'INVALID_WALLET', detail: error.message };
  }
  if (classifyTransient(error)) {
    return {
      status: 503,
      code: 'TEMPORARILY_UNAVAILABLE',
      detail:
        'the service could not complete the request right now; retry with the same Idempotency-Key',
    };
  }
  return undefined;
}
