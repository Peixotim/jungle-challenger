import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../../errors/domain-errors.js';
import { MoneyProps } from '../dtos/MoneyProps.js';

const D = Decimal.clone({ precision: 40 });

const AMOUNT = /^\d+(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private readonly value: Decimal;

  private constructor(
    value: Decimal,
    public readonly currency: string,
  ) {
    this.value = value.isZero() ? new D(0) : value;
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
      throw new InvalidMoneyError(`invalid amount: "${amount}"`);
    }
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`invalid currency: "${currency}"`);
    }
    return new Money(new D(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
