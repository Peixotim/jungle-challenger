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
