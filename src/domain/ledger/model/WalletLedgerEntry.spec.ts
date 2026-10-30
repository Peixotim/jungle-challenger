import {
  CurrencyMismatchError,
  InvalidLedgerEntryError,
} from '../../errors/domain-errors.js';
import { Money } from '../../money/model/Money.js';
import { LedgerDirection } from '../enums/LedgerDirection.js';
import { WalletLedgerEntry } from './WalletLedgerEntry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const props = (
  over: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) => ({
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('WalletLedgerEntry', () => {
  it('creates a balanced debit', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a balanced credit', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects an unbalanced entry', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: brl('80.00') })),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects zero amount and negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0.00') })),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(
        props({
          money: brl('25.00'),
          balanceBefore: brl('10.00'),
          balanceAfter: brl('10.00').subtract(brl('25.00')),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects mixed currencies', () => {
    const usd = Money.from({ amount: '75.00', currency: 'USD' });
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: usd })),
    ).toThrow(CurrencyMismatchError);
  });

  it('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { id: string }).id = 'other';
    }).toThrow(TypeError);
  });

  it('rehydrate does not revalidate', () => {
    const entry = WalletLedgerEntry.rehydrate(
      props({ balanceAfter: brl('1.00') }),
    );
    expect(entry.isBalanced()).toBe(false);
  });
});
