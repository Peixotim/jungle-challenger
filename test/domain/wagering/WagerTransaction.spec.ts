import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../../src/domain/errors/domain-errors.js';
import { LedgerDirection } from '../../../src/domain/ledger/enums/LedgerDirection.js';
import { Money } from '../../../src/domain/money/model/Money.js';
import { CreateWagerTransactionProps } from '../../../src/domain/wagering/dtos/CreateWagerTransactionProps.js';
import { FailureCode } from '../../../src/domain/wagering/enums/FailureCode.js';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { WagerTransaction } from '../../../src/domain/wagering/model/WagerTransaction.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');

const make = (over: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({
    id: 'tx1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: now,
    ...over,
  });

const makeReversal = (
  kind: Kind.Refund | Kind.Rollback,
  over: Partial<CreateWagerTransactionProps> = {},
) =>
  make({
    id: 'tx2',
    externalTransactionId: 'ext-2',
    kind,
    referenceExternalTransactionId: 'ext-1',
    ...over,
  });

const processed = (over: Partial<CreateWagerTransactionProps> = {}) => {
  const tx = make(over);
  tx.markProcessed(undefined, now);
  return tx;
};

describe('WagerTransaction', () => {
  describe('create', () => {
    it('is born PENDING', () => {
      const tx = make();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.processedAt).toBeUndefined();
    });

    it('refuses OPENING from the provider-facing factory', () => {
      expect(() => make({ kind: Kind.Opening })).toThrow(
        InvalidTransactionError,
      );
    });

    it.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
      expect(() => make({ kind })).toThrow(InvalidTransactionError);
      expect(() =>
        makeReversal(kind as Kind.Refund | Kind.Rollback),
      ).not.toThrow();
    });

    it('BET cannot carry a reference; WIN and LOSS may', () => {
      expect(() => make({ referenceExternalTransactionId: 'ext-0' })).toThrow(
        InvalidTransactionError,
      );
      expect(() =>
        make({ kind: Kind.Win, referenceExternalTransactionId: 'ext-0' }),
      ).not.toThrow();
      expect(() => make({ kind: Kind.Loss })).not.toThrow();
    });

    it('rejects blank fields and non-positive amounts', () => {
      expect(() => make({ providerId: ' ' })).toThrow(InvalidTransactionError);
      expect(() => make({ idempotencyKey: '' })).toThrow(
        InvalidTransactionError,
      );
      expect(() => make({ money: brl('0.00') })).toThrow(
        InvalidTransactionError,
      );
      expect(() =>
        make({ kind: Kind.Win, referenceExternalTransactionId: ' ' }),
      ).toThrow(InvalidTransactionError);
    });
  });

  describe('opening', () => {
    it('builds the internal OPENING credit', () => {
      const tx = WagerTransaction.opening({
        id: 'tx0',
        walletId: 'w1',
        playerId: 'p1',
        money: brl('1000.00'),
        payloadHash: 'h',
        createdAt: now,
      });
      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.externalTransactionId).toBe('opening:w1');
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      tx.markProcessed(undefined, now);
      expect(tx.status).toBe(Status.Processed);
    });
  });

  describe('transitions', () => {
    it('PENDING -> PROCESSED stores processedAt', () => {
      const tx = make();
      tx.markProcessed(undefined, now);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.processedAt).toEqual(now);
      expect(tx.isTerminal()).toBe(true);
    });

    it('PENDING -> PENDING_REFERENCE schedules the first retry; then PROCESSED with the reference', () => {
      const tx = makeReversal(Kind.Refund);
      tx.markPendingReference(now);
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.nextReferenceAttemptAt).toEqual(new Date(now.getTime() + 1000));
      tx.markProcessed('tx-ref', now);
      expect(tx.referenceTransactionId).toBe('tx-ref');
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    });

    it('REFUND/ROLLBACK cannot be processed without the resolved reference', () => {
      expect(() =>
        makeReversal(Kind.Refund).markProcessed(undefined, now),
      ).toThrow(InvalidTransactionError);
    });

    it('reject and fail record the failure code', () => {
      const rejected = make();
      rejected.reject(FailureCode.InsufficientFunds);
      expect(rejected.status).toBe(Status.Rejected);
      expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

      const failed = make();
      failed.fail(FailureCode.InternalError);
      expect(failed.status).toBe(Status.Failed);
    });

    it('PENDING_REFERENCE can be rejected (attempts exhausted)', () => {
      const tx = makeReversal(Kind.Rollback);
      tx.markPendingReference(now);
      tx.reject(FailureCode.ReferenceNotFound);
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    });

    it.each([
      [
        'markProcessed',
        (tx: WagerTransaction) => tx.markProcessed(undefined, now),
      ],
      [
        'markPendingReference',
        (tx: WagerTransaction) => tx.markPendingReference(now),
      ],
      [
        'reject',
        (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds),
      ],
      ['fail', (tx: WagerTransaction) => tx.fail(FailureCode.InternalError)],
    ])('terminal states refuse %s', (_name, act) => {
      for (const terminate of [
        (tx: WagerTransaction) => tx.markProcessed(undefined, now),
        (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds),
        (tx: WagerTransaction) => tx.fail(FailureCode.InternalError),
      ]) {
        const tx = make();
        terminate(tx);
        expect(() => act(tx)).toThrow(InvalidTransactionStateError);
      }
    });

    it('markPendingReference only from PENDING', () => {
      const tx = makeReversal(Kind.Refund);
      tx.markPendingReference(now);
      expect(() => tx.markPendingReference(now)).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('reference retries', () => {
    it('backs off exponentially and reports when due', () => {
      const tx = makeReversal(Kind.Refund);
      tx.markPendingReference(now);
      expect(tx.isReferenceRetryDue(now)).toBe(false);
      expect(tx.isReferenceRetryDue(new Date(now.getTime() + 1000))).toBe(true);

      tx.scheduleReferenceRetry(now);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.nextReferenceAttemptAt).toEqual(new Date(now.getTime() + 2000));
      tx.scheduleReferenceRetry(now);
      expect(tx.nextReferenceAttemptAt).toEqual(new Date(now.getTime() + 4000));
    });

    it('scheduleReferenceRetry only while PENDING_REFERENCE', () => {
      expect(() => make().scheduleReferenceRetry(now)).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('queries', () => {
    it('affectsBalance is false only for LOSS', () => {
      expect(make({ kind: Kind.Loss }).affectsBalance()).toBe(false);
      expect(make({ kind: Kind.Bet }).affectsBalance()).toBe(true);
      expect(make({ kind: Kind.Win }).affectsBalance()).toBe(true);
    });

    it('requiresReference is true for REFUND and ROLLBACK', () => {
      expect(makeReversal(Kind.Refund).requiresReference()).toBe(true);
      expect(makeReversal(Kind.Rollback).requiresReference()).toBe(true);
      expect(make().requiresReference()).toBe(false);
    });

    it('matchesPayload compares the hash', () => {
      const tx = make();
      expect(tx.matchesPayload('hash-1')).toBe(true);
      expect(tx.matchesPayload('other')).toBe(false);
    });

    it('overdrawFailureCode differs between BET and reversals', () => {
      expect(make().overdrawFailureCode()).toBe(FailureCode.InsufficientFunds);
      expect(makeReversal(Kind.Rollback).overdrawFailureCode()).toBe(
        FailureCode.ReversalWouldOverdraw,
      );
    });
  });

  describe('ledgerDirectionFor', () => {
    it('BET debits; WIN, REFUND credit', () => {
      expect(make().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(make({ kind: Kind.Win }).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );
      expect(makeReversal(Kind.Refund).ledgerDirectionFor()).toBe(
        LedgerDirection.Credit,
      );
    });

    it('ROLLBACK inverts its reference', () => {
      const rollback = makeReversal(Kind.Rollback);
      expect(rollback.ledgerDirectionFor(processed())).toBe(
        LedgerDirection.Credit,
      ); // of a BET
      expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Win }))).toBe(
        LedgerDirection.Debit,
      );
      expect(() => rollback.ledgerDirectionFor()).toThrow(
        InvalidTransactionError,
      );
    });

    it('LOSS has no ledger effect', () => {
      expect(() => make({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
        InvalidTransactionError,
      );
    });
  });

  describe('checkReference', () => {
    it('accepts a matching processed BET for REFUND and ROLLBACK', () => {
      expect(
        makeReversal(Kind.Refund).checkReference(processed()),
      ).toBeUndefined();
      expect(
        makeReversal(Kind.Rollback).checkReference(processed()),
      ).toBeUndefined();
    });

    it('ROLLBACK may reference WIN and REFUND; REFUND only BET', () => {
      const win = processed({ kind: Kind.Win });
      expect(makeReversal(Kind.Rollback).checkReference(win)).toBeUndefined();
      expect(makeReversal(Kind.Refund).checkReference(win)).toBe(
        FailureCode.InvalidReferenceKind,
      );
    });

    it('ROLLBACK cannot reference a LOSS', () => {
      expect(
        makeReversal(Kind.Rollback).checkReference(
          processed({ kind: Kind.Loss }),
        ),
      ).toBe(FailureCode.InvalidReferenceKind);
    });

    it.each([
      ['provider', { providerId: 'provider-b' }],
      ['player', { playerId: 'p2' }],
      ['wallet', { walletId: 'w2' }],
      ['round', { roundId: 'round-2' }],
      ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ])('rejects a reference from another %s', (_name, over) => {
      expect(makeReversal(Kind.Refund).checkReference(processed(over))).toBe(
        FailureCode.ReferenceMismatch,
      );
    });

    it('rejects a different amount for REFUND/ROLLBACK', () => {
      expect(
        makeReversal(Kind.Refund, { money: brl('10.00') }).checkReference(
          processed(),
        ),
      ).toBe(FailureCode.AmountMismatch);
    });

    it('does not require equal amounts for WIN referencing a BET', () => {
      const win = make({
        id: 'tx3',
        externalTransactionId: 'ext-3',
        kind: Kind.Win,
        money: brl('50.00'),
        referenceExternalTransactionId: 'ext-1',
      });
      expect(win.checkReference(processed())).toBeUndefined();
    });

    it('rejects a reference that was not PROCESSED', () => {
      const rejected = make();
      rejected.reject(FailureCode.InsufficientFunds);
      expect(makeReversal(Kind.Refund).checkReference(rejected)).toBe(
        FailureCode.ReferenceNotProcessed,
      );
    });

    it('rejects a reference with a different external id', () => {
      expect(
        makeReversal(Kind.Refund).checkReference(
          processed({ externalTransactionId: 'ext-9' }),
        ),
      ).toBe(FailureCode.ReferenceMismatch);
    });
  });

  it('rehydrate restores a terminal state without revalidating', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Bet,
      money: brl('1.00'),
      createdAt: now,
      status: Status.Processed,
      processedAt: now,
      referenceAttempts: 0,
    });
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(
      InvalidTransactionStateError,
    );
  });
});
