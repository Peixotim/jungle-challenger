import { IdempotencyConflictError } from '../../src/application/errors/application-errors.js';
import { SubmitWagerTransaction } from '../../src/application/use-cases/SubmitWagerTransaction.js';
import {
  InvalidMoneyError,
  InvalidTransactionError,
} from '../../src/domain/errors/domain-errors.js';
import { FailureCode } from '../../src/domain/wagering/enums/FailureCode.js';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { command, harness, money, next } from './fakes/harness.js';

function setup(balance = '1000.00') {
  const { db, clock, ids, processor } = harness({ balance });
  const useCase = new SubmitWagerTransaction(db.uow, clock, ids, processor);
  return { db, useCase };
}

describe('SubmitWagerTransaction', () => {
  describe('applying operations', () => {
    it('BET debits the wallet and records ledger and events', async () => {
      const { db, useCase } = setup();

      const result = await useCase.execute(command());

      expect(result).toMatchObject({
        status: Status.Processed,
        balance: money('975.00'),
        idempotentReplay: false,
      });
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('975.00'));
      expect(db.ledger).toHaveLength(2);
      expect(db.eventTypes()).toEqual([
        'WalletBalanceChanged',
        'WagerTransactionProcessed',
      ]);
      expect(db.ledgerBalance('w1').equals(db.wallets.get('w1')!.balance)).toBe(
        true,
      );
    });

    it('WIN credits the wallet', async () => {
      const { db, useCase } = setup();
      const result = await useCase.execute(
        command({ kind: Kind.Win, money: money('50.00') }),
      );
      expect(result.balance).toEqual(money('1050.00'));
      expect(db.ledgerBalance('w1').equals(db.wallets.get('w1')!.balance)).toBe(
        true,
      );
    });

    it('LOSS is processed without ledger entry or balance event', async () => {
      const { db, useCase } = setup();

      const result = await useCase.execute(command({ kind: Kind.Loss }));

      expect(result).toMatchObject({
        status: Status.Processed,
        balance: money('1000.00'),
      });
      expect(db.ledger).toHaveLength(1);
      expect(db.eventTypes()).toEqual(['WagerTransactionProcessed']);
    });

    it('rejects a BET without funds: no movement, no ledger, rejection event', async () => {
      const { db, useCase } = setup('10.00');

      const result = await useCase.execute(command());

      expect(result).toMatchObject({
        status: Status.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        balance: money('10.00'),
        idempotentReplay: false,
      });
      expect(db.ledger).toHaveLength(1);
      expect(db.wallets.get('w1')!.version).toBe(1);
      expect(db.eventTypes()).toEqual(['WagerTransactionRejected']);
    });

    it('rejects an unknown wallet, a foreign player and a foreign currency', async () => {
      const { useCase } = setup();

      expect(
        await useCase.execute(next('a', { walletId: 'nope' })),
      ).toMatchObject({ failureCode: FailureCode.WalletNotFound });
      expect(
        await useCase.execute(next('b', { playerId: 'someone-else' })),
      ).toMatchObject({ failureCode: FailureCode.WalletPlayerMismatch });
      expect(
        await useCase.execute(
          next('c', { money: { amount: '1.00', currency: 'USD' } }),
        ),
      ).toMatchObject({ failureCode: FailureCode.CurrencyMismatch });
    });

    it('validates input before opening any transaction', async () => {
      const { db, useCase } = setup();

      await expect(
        useCase.execute(command({ money: money('25.001') })),
      ).rejects.toThrow(InvalidMoneyError);
      await expect(
        useCase.execute(command({ kind: Kind.Opening })),
      ).rejects.toThrow(InvalidTransactionError);
      expect(db.transactions.size).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replays the same request: same answer, no second movement', async () => {
      const { db, useCase } = setup();

      const first = await useCase.execute(command());
      const second = await useCase.execute(command());

      expect(second).toEqual({ ...first, idempotentReplay: true });
      expect(db.transactions.size).toBe(1);
      expect(db.ledger).toHaveLength(2);
      expect(db.outbox).toHaveLength(2);
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('975.00'));
    });

    it('a replay returns the balance observed originally, not the current one', async () => {
      const { useCase } = setup();

      await useCase.execute(command());
      await useCase.execute(next('tx-2', { money: money('100.00') }));
      const replay = await useCase.execute(command());

      expect(replay.balance).toEqual(money('975.00'));
      expect(replay.idempotentReplay).toBe(true);
    });

    it('a rejection is also replayed as-is, even if funds arrive later', async () => {
      const { db, useCase } = setup('10.00');

      const first = await useCase.execute(command());
      await useCase.execute(
        next('tx-2', { kind: Kind.Win, money: money('500.00') }),
      );
      const replay = await useCase.execute(command());

      expect(first.status).toBe(Status.Rejected);
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('510.00'));
    });

    it('treats the same key with a different payload as a conflict, not a replay', async () => {
      const { db, useCase } = setup();
      await useCase.execute(command());

      const attempt = useCase.execute(command({ money: money('30.00') }));

      await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(attempt).rejects.toMatchObject({
        reason: 'PAYLOAD_MISMATCH',
      });
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('975.00'));
    });

    it('treats the same provider transaction id under another key as a conflict', async () => {
      const { useCase } = setup();
      await useCase.execute(command());

      await expect(
        useCase.execute(command({ idempotencyKey: 'another-key' })),
      ).rejects.toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });
    });

    it('50 identical submissions apply the debit exactly once', async () => {
      const { db, useCase } = setup();

      const results = await Promise.all(
        Array.from({ length: 50 }, () => useCase.execute(command())),
      );

      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(db.ledger).toHaveLength(2);
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('975.00'));
      expect(db.ledgerBalance('w1').equals(db.wallets.get('w1')!.balance)).toBe(
        true,
      );
    });

    it('two BETs of 80 on a balance of 100: one processed, one rejected, one debit', async () => {
      const { db, useCase } = setup('100.00');

      const results = await Promise.all([
        useCase.execute(next('bet-a', { money: money('80.00') })),
        useCase.execute(next('bet-b', { money: money('80.00') })),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([
        Status.Processed,
        Status.Rejected,
      ]);
      expect(
        results.find((r) => r.status === Status.Rejected)?.failureCode,
      ).toBe(FailureCode.InsufficientFunds);
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('20.00'));
      expect(db.ledger).toHaveLength(2);
      expect(db.ledgerBalance('w1').equals(db.wallets.get('w1')!.balance)).toBe(
        true,
      );
    });
  });

  describe('inbox (SQS)', () => {
    const source = { consumerName: 'wager-consumer', messageId: 'msg-1' };

    it('records the message as processed together with the operation', async () => {
      const { db, useCase } = setup();

      await useCase.execute(command({ source }));

      const message = db.inbox.get('wager-consumer:msg-1');
      expect(message?.isProcessed()).toBe(true);
      expect(db.outbox[0].payload).toMatchObject({ causationId: 'msg-1' });
    });

    it('a redelivered message does not repeat the movement', async () => {
      const { db, useCase } = setup();

      const first = await useCase.execute(command({ source }));
      const redelivery = await useCase.execute(command({ source }));

      expect(redelivery).toEqual({ ...first, idempotentReplay: true });
      expect(db.inbox.size).toBe(1);
      expect(db.ledger).toHaveLength(2);
    });

    it('the same operation arriving by another channel is a replay and is still recorded', async () => {
      const { db, useCase } = setup();

      await useCase.execute(command());
      const viaQueue = await useCase.execute(command({ source }));

      expect(viaQueue.idempotentReplay).toBe(true);
      expect(db.inbox.get('wager-consumer:msg-1')?.isProcessed()).toBe(true);
      expect(db.ledger).toHaveLength(2);
    });
  });

  describe('reversals', () => {
    it('REFUND credits back a processed BET', async () => {
      const { db, useCase } = setup();
      await useCase.execute(command());

      const refund = await useCase.execute(
        next('tx-2', {
          kind: Kind.Refund,
          referenceExternalTransactionId: 'tx-1',
        }),
      );

      expect(refund).toMatchObject({
        status: Status.Processed,
        balance: money('1000.00'),
      });
      expect(db.ledgerBalance('w1').equals(db.wallets.get('w1')!.balance)).toBe(
        true,
      );
    });

    it('a second REFUND of the same BET is rejected as already reversed', async () => {
      const { db, useCase } = setup();
      await useCase.execute(command());
      const refund = (id: string) =>
        useCase.execute(
          next(id, {
            kind: Kind.Refund,
            referenceExternalTransactionId: 'tx-1',
          }),
        );
      await refund('tx-2');

      const second = await refund('tx-3');

      expect(second).toMatchObject({
        status: Status.Rejected,
        failureCode: FailureCode.AlreadyReversed,
      });
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('1000.00'));
    });

    it('ROLLBACK of a WIN debits it back', async () => {
      const { useCase } = setup();
      await useCase.execute(command({ kind: Kind.Win, money: money('50.00') }));

      const rollback = await useCase.execute(
        next('tx-2', {
          kind: Kind.Rollback,
          money: money('50.00'),
          referenceExternalTransactionId: 'tx-1',
        }),
      );

      expect(rollback.balance).toEqual(money('1000.00'));
    });

    it('a reversal that would overdraw is rejected with its own code', async () => {
      const { db, useCase } = setup('100.00');
      await useCase.execute(command({ kind: Kind.Win, money: money('50.00') }));
      await useCase.execute(next('tx-2', { money: money('140.00') }));

      const rollback = await useCase.execute(
        next('tx-3', {
          kind: Kind.Rollback,
          money: money('50.00'),
          referenceExternalTransactionId: 'tx-1',
        }),
      );

      expect(rollback).toMatchObject({
        status: Status.Rejected,
        failureCode: FailureCode.ReversalWouldOverdraw,
        balance: money('10.00'),
      });
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('10.00'));
    });

    it('rejects a reversal whose amount differs from the reference', async () => {
      const { useCase } = setup();
      await useCase.execute(command());

      const refund = await useCase.execute(
        next('tx-2', {
          kind: Kind.Refund,
          money: money('10.00'),
          referenceExternalTransactionId: 'tx-1',
        }),
      );

      expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
    });
  });

  describe('out-of-order references', () => {
    it('parks a REFUND that arrives before its BET, without touching the balance', async () => {
      const { db, useCase } = setup();

      const result = await useCase.execute(
        next('tx-2', {
          kind: Kind.Refund,
          referenceExternalTransactionId: 'tx-1',
        }),
      );

      expect(result).toMatchObject({
        status: Status.PendingReference,
        idempotentReplay: false,
      });
      expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('1000.00'));
      expect(db.ledger).toHaveLength(1);
      expect(db.eventTypes()).toEqual(['WagerTransactionPendingReference']);
    });

    it('replaying a parked transaction answers with its current state', async () => {
      const { useCase } = setup();
      const refund = next('tx-2', {
        kind: Kind.Refund,
        referenceExternalTransactionId: 'tx-1',
      });

      const first = await useCase.execute(refund);
      const replay = await useCase.execute(refund);

      expect(replay).toEqual({ ...first, idempotentReplay: true });
    });
  });
});
