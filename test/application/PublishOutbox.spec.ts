import { PublishOutbox } from '../../src/application/use-cases/PublishOutbox.js';
import { SubmitWagerTransaction } from '../../src/application/use-cases/SubmitWagerTransaction.js';
import { command, harness } from './fakes/harness.js';

function setup(batchSize?: number) {
  const h = harness({ balance: '1000.00' });
  return {
    ...h,
    submit: new SubmitWagerTransaction(h.db.uow, h.clock, h.ids, h.processor),
    publish: new PublishOutbox(
      h.db.uow,
      h.publisher,
      h.clock,
      h.metrics,
      h.logger,
      batchSize,
    ),
  };
}

describe('PublishOutbox', () => {
  it('publishes pending events once and marks them published', async () => {
    const { db, submit, publish, publisher } = setup();
    await submit.execute(command());

    const result = await publish.execute();

    expect(result).toEqual({ published: 2, failed: 0 });
    expect(publisher.published.map((m) => m.eventType)).toEqual([
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
    ]);
    expect(db.outbox.every((m) => !m.isPending())).toBe(true);
  });

  it('does not publish the same message again on the next tick', async () => {
    const { submit, publish, publisher } = setup();
    await submit.execute(command());
    await publish.execute();

    const second = await publish.execute();

    expect(second).toEqual({ published: 0, failed: 0 });
    expect(publisher.published).toHaveLength(2);
  });

  it('two publishers over the same outbox never double-publish', async () => {
    const { db, submit, clock, metrics, logger, publisher } = setup();
    const other = new PublishOutbox(db.uow, publisher, clock, metrics, logger);
    const first = new PublishOutbox(db.uow, publisher, clock, metrics, logger);
    await submit.execute(command());

    const results = await Promise.all([first.execute(), other.execute()]);

    expect(results.reduce((sum, r) => sum + r.published, 0)).toBe(2);
    expect(publisher.published).toHaveLength(2);
  });

  it('a failed publish is retried later with backoff, not lost', async () => {
    const { db, clock, submit, publish, publisher, metrics, logger } = setup();
    await submit.execute(command());
    publisher.failNext(1);

    const failed = await publish.execute();

    expect(failed).toEqual({ published: 1, failed: 1 });
    const stuck = db.outbox.find((m) => m.isPending())!;
    expect(stuck.attempts).toBe(1);
    expect(stuck.nextAttemptAt!.getTime() - clock.now().getTime()).toBe(2_000);
    expect(metrics.count('outbox_publish_failures_total')).toBe(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'warn',
      fields: { messageId: stuck.id, reason: 'broker unavailable' },
    });

    expect(await publish.execute()).toEqual({ published: 0, failed: 0 });
    clock.advance(2_000);
    expect(await publish.execute()).toEqual({ published: 1, failed: 0 });
    expect(db.outbox.every((m) => !m.isPending())).toBe(true);
    expect(publisher.published).toHaveLength(2);
  });

  it('survives a crash after commit: a new publisher picks up what was never published', async () => {
    const { db, submit, clock, metrics, logger, publisher } = setup();
    await submit.execute(command());

    const replacement = new PublishOutbox(
      db.uow,
      publisher,
      clock,
      metrics,
      logger,
    );

    expect(await replacement.execute()).toEqual({ published: 2, failed: 0 });
  });

  it('records the publish lag', async () => {
    const { clock, submit, publish, metrics } = setup();
    await submit.execute(command());
    clock.advance(5_000);

    await publish.execute();

    expect(metrics.observations).toEqual([
      { name: 'outbox_lag_seconds', value: 5 },
      { name: 'outbox_lag_seconds', value: 5 },
    ]);
  });

  it('respects the batch size', async () => {
    const { submit, publish, publisher } = setup(1);
    await submit.execute(command());

    expect((await publish.execute()).published).toBe(1);
    expect((await publish.execute()).published).toBe(1);
    expect(publisher.published).toHaveLength(2);
  });
});
