export abstract class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type IdempotencyConflictReason =
  'PAYLOAD_MISMATCH' | 'EXTERNAL_ID_REUSED';

export class IdempotencyConflictError extends ApplicationError {
  constructor(
    public readonly reason: IdempotencyConflictReason,
    public readonly idempotencyKey: string,
  ) {
    super(`idempotency conflict (${reason}) for key "${idempotencyKey}"`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {}

export class InvalidQueryError extends ApplicationError {}
