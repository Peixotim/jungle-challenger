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

export class InsufficientFundsError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}

export class InvalidTransactionError extends DomainError {}

export class InvalidTransactionStateError extends DomainError {
  constructor(transactionId: string, from: string, to: string) {
    super(`transaction ${transactionId}: invalid transition ${from} -> ${to}`);
  }
}

export class InvalidMessageStateError extends DomainError {}
