import { ReprocessPendingReferences } from '../../src/application/use-cases/ReprocessPendingReferences.js';
import { SubmitWagerTransaction } from '../../src/application/use-cases/SubmitWagerTransaction.js';
import { FailureCode } from '../../src/domain/wagering/enums/FailureCode.js';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { command, harness, money, next } from './fakes/harness.js';

function setup(maxReferenceAttempts?: number) {
  const h = harness({ balance: '1000.00', maxReferenceAttempts });
  return {
    ...h,
    submit: new SubmitWagerTransaction(
      h.db.uow,
      h.clock,
      h.ids,
      h.processor,
      h.metrics,
    ),
    worker: new ReprocessPendingReferences(
      h.db.uow,
      h.clock,
      h.processor,
      h.metrics,
      h.logger,
    ),
  };
}

const refundOfBet = () =>
  next('tx-2', { kind: Kind.Refund, referenceExternalTransactionId: 'tx-1' });

describe('ReprocessPendingReferences', () => {
  it('completes a REFUND once its BET has arrived', async () => {
    const { db, clock, submit, worker } = setup();
    const parked = await submit.execute(refundOfBet());
    expect(parked.status).toBe(Status.PendingReference);

    await submit.execute(command());
    clock.advance(1_000);
    const handled = await worker.execute();

    expect(handled).toBe(1);
    const refund = db.transactions.get(parked.transactionId)!;
    expect(refund.status).toBe(Status.Processed);
    expect(refund.observedBalance?.toJSON()).toEqual(money('1000.00'));
    expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('1000.00'));
    expect(db.ledgerBalance('w1').equals(db.wallets.get('w1')!.balance)).toBe(
      true,
    );
  });

  it('a replay of the parked request returns its final state', async () => {
    const { clock, submit, worker } = setup();
    const parked = await submit.execute(refundOfBet());
    await submit.execute(command());
    clock.advance(1_000);
    await worker.execute();

    const replay = await submit.execute(refundOfBet());

    expect(replay).toMatchObject({
      transactionId: parked.transactionId,
      status: Status.Processed,
      balance: money('1000.00'),
      idempotentReplay: true,
    });
  });

  it('skips transactions whose backoff has not elapsed', async () => {
    const { clock, submit, worker, db } = setup();
    await submit.execute(refundOfBet());
    await submit.execute(command());

    expect(await worker.execute()).toBe(0);
    clock.advance(999);
    expect(await worker.execute()).toBe(0);
    clock.advance(1);
    expect(await worker.execute()).toBe(1);
    expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('1000.00'));
  });

  it('keeps waiting with growing backoff while the reference is still missing', async () => {
    const { db, clock, submit, worker } = setup();
    const parked = await submit.execute(refundOfBet());
    const tx = db.transactions.get(parked.transactionId)!;

    clock.advance(1_000);
    await worker.execute();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt!.getTime() - clock.now().getTime()).toBe(
      2_000,
    );

    clock.advance(2_000);
    await worker.execute();
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceAttemptAt!.getTime() - clock.now().getTime()).toBe(
      4_000,
    );
    expect(db.eventTypes()).toEqual(['WagerTransactionPendingReference']);
  });

  it('rejects with REFERENCE_NOT_FOUND after exhausting the attempts, and publishes the event', async () => {
    const { db, clock, submit, worker, metrics } = setup(3);
    const parked = await submit.execute(refundOfBet());
    const tx = db.transactions.get(parked.transactionId)!;

    for (let i = 0; i < 3; i++) {
      clock.advance(60 * 60_000);
      await worker.execute();
    }

    expect(tx).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(tx.observedBalance?.toJSON()).toEqual(money('1000.00'));
    expect(db.eventTypes()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('1000.00'));
    expect(metrics.count('wager_reference_retries_total')).toBe(3);

    clock.advance(60 * 60_000);
    expect(await worker.execute()).toBe(0);
  });

  it('a retry can reject for a business reason (amount mismatch)', async () => {
    const { db, clock, submit, worker } = setup();
    const parked = await submit.execute(
      next('tx-2', {
        kind: Kind.Refund,
        money: money('10.00'),
        referenceExternalTransactionId: 'tx-1',
      }),
    );
    await submit.execute(command());
    clock.advance(1_000);

    await worker.execute();

    expect(db.transactions.get(parked.transactionId)).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.AmountMismatch,
    });
    expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('975.00'));
  });

  it('a ROLLBACK waits for a reference that is itself parked', async () => {
    const { db, clock, submit, worker } = setup();
    await submit.execute(refundOfBet());
    const rollback = await submit.execute(
      next('tx-3', {
        kind: Kind.Rollback,
        referenceExternalTransactionId: 'tx-2',
      }),
    );
    expect(rollback.status).toBe(Status.PendingReference);

    await submit.execute(command());
    clock.advance(1_000);
    await worker.execute();

    clock.advance(60_000);
    await worker.execute();

    expect(db.transactions.get(rollback.transactionId)!.status).toBe(
      Status.Processed,
    );
    expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('975.00'));
    expect(db.ledgerBalance('w1').equals(db.wallets.get('w1')!.balance)).toBe(
      true,
    );
  });

  it('honors the batch limit', async () => {
    const { clock, submit, worker } = setup();
    await submit.execute(refundOfBet());
    await submit.execute(
      next('tx-4', {
        kind: Kind.Refund,
        referenceExternalTransactionId: 'tx-9',
      }),
    );
    clock.advance(1_000);

    expect(await worker.execute(1)).toBe(1);
  });
});
