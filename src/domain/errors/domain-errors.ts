export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InvalidWalletError extends DomainError {}

/** A debit would leave the wallet balance negative. */
export class InsufficientFundsError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}

/** A transaction was built with data that violates its kind's rules. */
export class InvalidTransactionError extends DomainError {}

/** Programming error: a state transition that is not allowed (e.g. from a terminal state). */
export class InvalidTransactionStateError extends DomainError {
  constructor(transactionId: string, from: string, to: string) {
    super(`transaction ${transactionId}: invalid transition ${from} -> ${to}`);
  }
}

/** Programming error: inbox/outbox message used after it reached its final state. */
export class InvalidMessageStateError extends DomainError {}
