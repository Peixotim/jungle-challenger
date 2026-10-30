import { InvalidTransactionError } from '../../errors/domain-errors.js';
import { LedgerDirection } from '../../ledger/enums/LedgerDirection.js';
import { Money } from '../../money/model/Money.js';
import { FailureCode } from '../../wagering/enums/FailureCode.js';
import { WagerTransactionKind as Kind } from '../../wagering/enums/WagerTransactionKind.js';
import { WagerTransaction } from '../../wagering/model/WagerTransaction.js';
import { Wallet } from '../../wallet/model/Wallet.js';
import { EventContext } from '../dtos/EventContext.js';
import { WagerTransactionPendingReference } from './WagerTransactionPendingReference.js';
import { WagerTransactionProcessed } from './WagerTransactionProcessed.js';
import { WagerTransactionRejected } from './WagerTransactionRejected.js';
import { WalletBalanceChanged } from './WalletBalanceChanged.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');
const ctx: EventContext = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: now,
};

const tx = (kind: Kind = Kind.Bet, referenceExternalTransactionId?: string) =>
  WagerTransaction.create({
    id: 'tx1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'h',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId,
    createdAt: now,
  });

describe('integration events', () => {
  it('WalletBalanceChanged carries MoneyProps and the wallet version', () => {
    const { wallet } = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      initialBalance: brl('100.00'),
      now,
      opening: { entryId: 'e0', transactionId: 't0' },
    });
    const entry = wallet.debit({
      entryId: 'e1',
      transactionId: 'tx1',
      money: brl('25.00'),
      at: now,
    });

    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('w1');
    expect(event.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      data: {
        walletId: 'w1',
        transactionId: 'tx1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('WagerTransactionProcessed requires a PROCESSED transaction', () => {
    const t = tx(Kind.Loss);
    expect(() => WagerTransactionProcessed.from(t, ctx)).toThrow(
      InvalidTransactionError,
    );
    t.markProcessed(undefined, now);
    const event = WagerTransactionProcessed.from(t, ctx);
    expect(event.toJSON().eventType).toBe('WagerTransactionProcessed');
    expect(event.data).toMatchObject({
      transactionId: 'tx1',
      kind: Kind.Loss,
      processedAt: now.toISOString(),
    });
  });

  it('WagerTransactionRejected carries the failure code', () => {
    const t = tx();
    expect(() => WagerTransactionRejected.from(t, ctx)).toThrow(
      InvalidTransactionError,
    );
    t.reject(FailureCode.InsufficientFunds);
    expect(WagerTransactionRejected.from(t, ctx).data.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
  });

  it('WagerTransactionPendingReference carries the awaited reference', () => {
    const t = tx(Kind.Refund, 'ext-0');
    expect(() => WagerTransactionPendingReference.from(t, ctx)).toThrow(
      InvalidTransactionError,
    );
    t.markPendingReference(now);
    const event = WagerTransactionPendingReference.from(t, ctx);
    expect(event.data.referenceExternalTransactionId).toBe('ext-0');
    expect(event.aggregateId).toBe('tx1');
  });

  it('payloads are plain JSON (no domain instances)', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds);
    const json = JSON.parse(
      JSON.stringify(WagerTransactionRejected.from(t, ctx).toJSON()),
    );
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });
});
