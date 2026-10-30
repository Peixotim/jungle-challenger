import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidWalletError,
} from '../../errors/domain-errors.js';
import { LedgerDirection } from '../../ledger/enums/LedgerDirection.js';
import { Money } from '../../money/model/Money.js';
import { Wallet } from './Wallet.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:01Z');

const open = (balance = '100.00') =>
  Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(balance),
    now: t0,
    opening: { entryId: 'e0', transactionId: 'tx0' },
  });

const move = (amount: string, entryId = 'e1') => ({
  entryId,
  transactionId: 'tx1',
  money: brl(amount),
  at: t1,
});

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with an OPENING credit entry', () => {
      const { wallet, openingEntry } = open('1000.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toJSON().amount).toBe('1000.00');
      expect(wallet.currency).toBe('BRL');
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.balanceBefore.isZero()).toBe(true);
      expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    });

    it('opens empty without a ledger entry', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'w1',
        playerId: 'p1',
        initialBalance: Money.zero('BRL'),
        now: t0,
      });
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    it('requires opening ids for a positive balance', () => {
      expect(() =>
        Wallet.open({
          id: 'w1',
          playerId: 'p1',
          initialBalance: brl('1.00'),
          now: t0,
        }),
      ).toThrow(InvalidWalletError);
    });

    it('rejects a negative initial balance', () => {
      const negative = brl('1.00').subtract(brl('2.00'));
      expect(() =>
        Wallet.open({
          id: 'w1',
          playerId: 'p1',
          initialBalance: negative,
          now: t0,
        }),
      ).toThrow(InvalidWalletError);
    });
  });

  describe('debit / credit', () => {
    it('debit moves the balance, bumps the version and returns a matching entry', () => {
      const { wallet } = open();
      const entry = wallet.debit(move('80.00'));
      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(t1);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    });

    it('credit moves the balance, bumps the version and returns a matching entry', () => {
      const { wallet } = open();
      const entry = wallet.credit(move('50.00'));
      expect(wallet.balance.toJSON().amount).toBe('150.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.isBalanced()).toBe(true);
    });

    it('allows spending the exact balance', () => {
      const { wallet } = open();
      wallet.debit(move('100.00'));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('refuses to go negative and leaves the wallet untouched', () => {
      const { wallet } = open();
      expect(() => wallet.debit(move('100.01'))).toThrow(
        InsufficientFundsError,
      );
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(t0);
    });

    it('rejects a different currency', () => {
      const { wallet } = open();
      const usd = {
        ...move('1.00'),
        money: Money.from({ amount: '1.00', currency: 'USD' }),
      };
      expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });

    it('rejects zero amounts without changing the version', () => {
      const { wallet } = open();
      expect(() => wallet.credit(move('0.00'))).toThrow(InvalidMoneyError);
      expect(wallet.version).toBe(1);
    });

    it('keeps balance equal to the replayed ledger', () => {
      const { wallet, openingEntry } = open('100.00');
      const entries = [
        openingEntry!,
        wallet.debit(move('30.00', 'e1')),
        wallet.credit(move('12.34', 'e2')),
        wallet.debit(move('0.34', 'e3')),
      ];
      const replayed = entries.reduce(
        (sum, e) =>
          e.direction === LedgerDirection.Credit
            ? sum.add(e.money)
            : sum.subtract(e.money),
        Money.zero('BRL'),
      );
      expect(replayed.equals(wallet.balance)).toBe(true);
    });
  });

  it('rehydrate restores state as-is', () => {
    const wallet = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: brl('7.00'),
      version: 5,
      createdAt: t0,
      updatedAt: t1,
    });
    expect(wallet.version).toBe(5);
    expect(wallet.balance.toJSON().amount).toBe('7.00');
  });
});
