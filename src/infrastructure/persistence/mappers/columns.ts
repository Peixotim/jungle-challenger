import { Money } from '../../../domain/money/model/Money.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toMoney(amount: string, currency: string): Money {
  return Money.from({ amount, currency: currency.trim() });
}

export function toMoneyOrUndefined(
  amount: string | null,
  currency: string,
): Money | undefined {
  return amount === null ? undefined : toMoney(amount, currency);
}
