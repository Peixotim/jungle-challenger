import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
} from '../../src/application/errors/application-errors.js';
import { UnitOfWork } from '../../src/application/ports/UnitOfWork.js';
import { WagerTransactionProcessor } from '../../src/application/services/WagerTransactionProcessor.js';
import { PublishOutbox } from '../../src/application/use-cases/PublishOutbox.js';
import { SubmitWagerTransaction } from '../../src/application/use-cases/SubmitWagerTransaction.js';
import { FailureCode } from '../../src/domain/wagering/enums/FailureCode.js';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/enums/WagerTransactionStatus.js';
import {
  App,
  buildApp,
  expectConsistent,
  money,
  OpenedWallet,
  openWallet,
  operation,
  walletBalance,
} from './support/app.js';
import { connectTestDatabase, TestDatabase } from './support/database.js';

describe('concurrency and failure recovery (real PostgreSQL)', () => {
  let db: TestDatabase;
  let app: App;

  beforeAll(async () => {
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    app = buildApp(db);
  });

  const count = async (
    table: string,
    where = 'true',
    params: unknown[] = [],
  ) => {
    const [row] = await db.query<{ n: string }>(
      `select count(*) as n from ${table} where ${where}`,
      params,
    );
    return Number(row.n);
  };

  describe('idempotency', () => {
    it('the same BET sent 50 times in parallel debits exactly once', async () => {
      const wallet = await openWallet(app, '1000.00');
      const command = operation(wallet);

      const results = await Promise.all(
        Array.from({ length: 50 }, () => app.submit.execute(command)),
      );

      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(new Set(results.map((r) => r.balance?.amount))).toEqual(
        new Set(['975.00']),
      );
      expect(await walletBalance(app, wallet)).toBe('975.00');
      expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(
        1,
      );
      expect(
        await count('wager_transactions', 'idempotency_key = ?', [
          command.idempotencyKey,
        ]),
      ).toBe(1);
      await expectConsistent(app, wallet);
    });

    it('a replay survives an application restart and returns the original answer', async () => {
      const wallet = await openWallet(app, '1000.00');
      const command = operation(wallet);
      const first = await app.submit.execute(command);
      await app.submit.execute(operation(wallet));

      const restartedDb = await connectTestDatabase();
      try {
        const restarted = buildApp(restartedDb);
        const replay = await restarted.submit.execute(command);

        expect(replay).toEqual({ ...first, idempotentReplay: true });
        expect(replay.balance?.amount).toBe('975.00');
        expect(await walletBalance(restarted, wallet)).toBe('950.00');
      } finally {
        await restartedDb.close();
      }
    });

    it('the same key with another payload is a conflict and changes nothing', async () => {
      const wallet = await openWallet(app, '1000.00');
      const command = operation(wallet);
      await app.submit.execute(command);

      await expect(
        app.submit.execute({ ...command, money: money('30.00') }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(
        app.submit.execute({ ...command, idempotencyKey: 'other-key' }),
      ).rejects.toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });

      expect(await walletBalance(app, wallet)).toBe('975.00');
      expect(await count('wager_transactions', "kind = 'BET'")).toBe(1);
    });

    it('a redelivered SQS message sent 20 times in parallel has one effect', async () => {
      const wallet = await openWallet(app, '1000.00');
      const command = {
        ...operation(wallet),
        source: { consumerName: 'wager-consumer', messageId: 'msg-1' },
      };

      const results = await Promise.all(
        Array.from({ length: 20 }, () => app.submit.execute(command)),
      );

      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(await walletBalance(app, wallet)).toBe('975.00');
      expect(await count('inbox_messages')).toBe(1);
      expect(await count('inbox_messages', 'processed_at is not null')).toBe(1);
      await expectConsistent(app, wallet);
    });

    it('a rejection for an unknown wallet is persisted and replayed', async () => {
      const wallet = await openWallet(app);
      const command = operation(wallet, { walletId: 'not-a-wallet' });

      const first = await app.submit.execute(command);
      const replay = await app.submit.execute(command);

      expect(first).toMatchObject({
        status: Status.Rejected,
        failureCode: FailureCode.WalletNotFound,
      });
      expect(replay).toEqual({ ...first, idempotentReplay: true });
    });
  });

  describe('lost updates and negative balances', () => {
    it('two BETs of 80 on a balance of 100: one processed, one rejected, one debit', async () => {
      const wallet = await openWallet(app, '100.00');

      const results = await Promise.all([
        app.submit.execute(operation(wallet, { money: money('80.00') })),
        app.submit.execute(operation(wallet, { money: money('80.00') })),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([
        Status.Processed,
        Status.Rejected,
      ]);
      expect(
        results.find((r) => r.status === Status.Rejected)?.failureCode,
      ).toBe(FailureCode.InsufficientFunds);
      expect(await walletBalance(app, wallet)).toBe('20.00');
      expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(
        1,
      );
      await expectConsistent(app, wallet);
    });

    it('a hot wallet: 100 concurrent BETs of 1.00 on 50.00 spend exactly 50.00', async () => {
      const wallet = await openWallet(app, '50.00');

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          app.submit.execute(operation(wallet, { money: money('1.00') })),
        ),
      );

      expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(
        50,
      );
      expect(results.filter((r) => r.status === Status.Rejected)).toHaveLength(
        50,
      );
      expect(await walletBalance(app, wallet)).toBe('0.00');
      expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(
        50,
      );
      const [{ version }] = await db.query<{ version: number }>(
        'select version from wallets where id = ?',
        [wallet.id],
      );
      expect(version).toBe(51);
      await expectConsistent(app, wallet);
    });

    it('different wallets are processed in parallel without interfering', async () => {
      const wallets = await Promise.all(
        Array.from({ length: 10 }, () => openWallet(app, '1000.00')),
      );

      await Promise.all(
        wallets.flatMap((wallet) =>
          Array.from({ length: 20 }, () =>
            app.submit.execute(operation(wallet, { money: money('5.00') })),
          ),
        ),
      );

      for (const wallet of wallets) {
        expect(await walletBalance(app, wallet)).toBe('900.00');
        await expectConsistent(app, wallet);
      }
    });

    it('concurrent wallet creation for one player and currency yields a single wallet', async () => {
      const playerId = randomUUID();
      const create = () =>
        app.createWallet.execute({
          playerId,
          initialBalance: money('100.00'),
          correlationId: randomUUID(),
        });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 10 }, create),
      );

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      for (const o of outcomes.filter((o) => o.status === 'rejected')) {
        expect((o as PromiseRejectedResult).reason).toBeInstanceOf(
          WalletAlreadyExistsError,
        );
      }
      expect(await count('wallets', 'player_id = ?', [playerId])).toBe(1);
      expect(await count('wallet_ledger_entries')).toBe(1);
    });
  });

  describe('atomicity', () => {
    it('a crash before commit leaves no trace in wallet, ledger, inbox, outbox or transactions', async () => {
      const wallet = await openWallet(app, '1000.00');
      const ledgerBefore = await count('wallet_ledger_entries');
      const outboxBefore = await count('outbox_messages');

      const crashing: UnitOfWork = {
        run: (work) =>
          app.uow.run(async (ctx) => {
            await work(ctx);
            throw new Error('process died before commit');
          }),
      };
      const submit = new SubmitWagerTransaction(
        crashing,
        app.clock,
        app.ids,
        new WagerTransactionProcessor(app.clock, app.ids),
        app.metrics,
      );
      const command = {
        ...operation(wallet),
        source: { consumerName: 'wager-consumer', messageId: 'msg-crash' },
      };

      await expect(submit.execute(command)).rejects.toThrow(
        'process died before commit',
      );

      expect(await walletBalance(app, wallet)).toBe('1000.00');
      expect(await count('wallet_ledger_entries')).toBe(ledgerBefore);
      expect(await count('outbox_messages')).toBe(outboxBefore);
      expect(await count('inbox_messages')).toBe(0);
      expect(await count('wager_transactions', "kind = 'BET'")).toBe(0);

      const retry = await app.submit.execute(command);
      expect(retry).toMatchObject({
        status: Status.Processed,
        idempotentReplay: false,
      });
      expect(await walletBalance(app, wallet)).toBe('975.00');
      await expectConsistent(app, wallet);
    });
  });

  describe('out-of-order references', () => {
    const refundOf = (wallet: OpenedWallet, reference: string) =>
      operation(wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: reference,
      });

    it('a REFUND delivered before its BET is parked and completes when the BET arrives', async () => {
      const wallet = await openWallet(app, '1000.00');
      const bet = operation(wallet);
      const refund = await app.submit.execute(
        refundOf(wallet, bet.externalTransactionId),
      );
      expect(refund.status).toBe(Status.PendingReference);

      await app.submit.execute(bet);
      app.clock.advance(1_000);
      expect(await app.reprocess.execute()).toBe(1);

      expect((await app.getTransaction.byId(refund.transactionId)).status).toBe(
        Status.Processed,
      );
      expect(await walletBalance(app, wallet)).toBe('1000.00');
      await expectConsistent(app, wallet);
    });

    it('a ROLLBACK delivered before its reference waits for it', async () => {
      const wallet = await openWallet(app, '1000.00');
      const win = operation(wallet, { kind: Kind.Win, money: money('50.00') });
      const rollback = await app.submit.execute(
        operation(wallet, {
          kind: Kind.Rollback,
          money: money('50.00'),
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      );
      expect(rollback.status).toBe(Status.PendingReference);

      await app.submit.execute(win);
      app.clock.advance(60_000);
      await app.reprocess.execute();

      expect(
        (await app.getTransaction.byId(rollback.transactionId)).status,
      ).toBe(Status.Processed);
      expect(await walletBalance(app, wallet)).toBe('1000.00');
      await expectConsistent(app, wallet);
    });

    it('gives up with REFERENCE_NOT_FOUND after the attempts are exhausted', async () => {
      const wallet = await openWallet(app, '1000.00');
      const refund = await app.submit.execute(
        refundOf(wallet, 'never-arrives'),
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        app.clock.advance(60 * 60_000);
        await app.reprocess.execute();
      }

      expect(await app.getTransaction.byId(refund.transactionId)).toMatchObject(
        {
          status: Status.Rejected,
          failureCode: FailureCode.ReferenceNotFound,
        },
      );
      expect(
        await count(
          'outbox_messages',
          "event_type = 'WagerTransactionRejected'",
        ),
      ).toBe(1);
      expect(await walletBalance(app, wallet)).toBe('1000.00');
    });

    it('several workers never process the same parked transaction twice', async () => {
      const wallet = await openWallet(app, '1000.00');
      const bets = Array.from({ length: 6 }, () => operation(wallet));
      const refunds = await Promise.all(
        bets.map((bet) =>
          app.submit.execute(refundOf(wallet, bet.externalTransactionId)),
        ),
      );
      await Promise.all(bets.map((bet) => app.submit.execute(bet)));
      expect(await walletBalance(app, wallet)).toBe('850.00');
      app.clock.advance(1_000);

      const handled = await Promise.all([
        app.reprocess.execute(),
        app.reprocess.execute(),
        app.reprocess.execute(),
      ]);

      expect(handled.reduce((a, b) => a + b, 0)).toBe(6);
      for (const refund of refunds) {
        expect(
          (await app.getTransaction.byId(refund.transactionId)).status,
        ).toBe(Status.Processed);
      }
      expect(await walletBalance(app, wallet)).toBe('1000.00');
      expect(await count('wallet_ledger_entries', "direction = 'CREDIT'")).toBe(
        7,
      );
      await expectConsistent(app, wallet);
    });
  });

  describe('transactional outbox', () => {
    const pending = () => count('outbox_messages', 'published_at is null');

    it('a process that dies after the commit and before publishing loses nothing', async () => {
      const wallet = await openWallet(app, '1000.00');
      await app.submit.execute(operation(wallet));
      expect(await pending()).toBe(4);

      const result = await app.publishOutbox().execute();

      expect(result).toEqual({ published: 4, failed: 0 });
      expect(await pending()).toBe(0);
      expect(await app.publishOutbox().execute()).toEqual({
        published: 0,
        failed: 0,
      });
    });

    it('concurrent publishers take disjoint batches: every event is published exactly once', async () => {
      const wallet = await openWallet(app, '1000.00');
      for (let i = 0; i < 10; i++) await app.submit.execute(operation(wallet));
      const total = await pending();
      expect(total).toBe(22);

      const drain = async () => {
        const publisher = app.publishOutbox(5);
        for (;;) {
          if ((await publisher.execute()).published === 0) return;
        }
      };
      await Promise.all([drain(), drain(), drain()]);

      const ids = app.publisher.published.map((m) => m.id);
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
      expect(await pending()).toBe(0);
    });

    it('a broker outage keeps the events and publishes them with backoff once it is back', async () => {
      const wallet = await openWallet(app, '1000.00');
      await app.submit.execute(operation(wallet));
      app.publisher.failNext(4);

      expect(await app.publishOutbox().execute()).toEqual({
        published: 0,
        failed: 4,
      });
      expect(await pending()).toBe(4);
      expect(await app.publishOutbox().execute()).toEqual({
        published: 0,
        failed: 0,
      });

      app.clock.advance(5_000);
      expect(await app.publishOutbox().execute()).toEqual({
        published: 4,
        failed: 0,
      });
      expect(await pending()).toBe(0);
    });

    it('a duplicate publication is possible but carries the same event id, so consumers can deduplicate', async () => {
      const wallet = await openWallet(app, '1000.00');
      await app.submit.execute(operation(wallet));
      const crashingUow: UnitOfWork = {
        run: (work) =>
          app.uow.run(async (ctx) => {
            await work(ctx);
            throw new Error(
              'process died after the broker accepted, before commit',
            );
          }),
      };
      const dying = new PublishOutbox(
        crashingUow,
        app.publisher,
        app.clock,
        app.metrics,
        app.logger,
      );

      await expect(dying.execute()).rejects.toThrow('process died');
      expect(app.publisher.published).toHaveLength(4);
      expect(await pending()).toBe(4);

      await app.publishOutbox().execute();

      const ids = app.publisher.published.map((m) => m.id);
      expect(ids).toHaveLength(8);
      expect(new Set(ids).size).toBe(4);
      expect(await pending()).toBe(0);
    });
  });

  describe('queries', () => {
    it('pages the ledger with an opaque cursor, in order, without gaps or repeats', async () => {
      const wallet = await openWallet(app, '1000.00');
      for (let i = 0; i < 6; i++) await app.submit.execute(operation(wallet));

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await app.getLedger.execute(wallet.id, {
          cursor,
          limit: 3,
        });
        seen.push(...page.entries.map((e) => e.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      const all = await app.getLedger.execute(wallet.id, { limit: 50 });
      expect(all.entries.map((e) => e.id)).toEqual(seen);
      expect(all.entries[0].balanceBefore.amount).toBe('0.00');
      expect(all.entries[6].balanceAfter.amount).toBe('850.00');
    });

    it('rejects a malformed cursor', async () => {
      const wallet = await openWallet(app);
      await expect(
        app.getLedger.execute(wallet.id, { cursor: 'not-a-cursor!' }),
      ).rejects.toThrow('invalid cursor');
    });

    it('treats an id that is not a uuid as not found', async () => {
      await expect(app.getWallet.execute('nope')).rejects.toThrow('not found');
      await expect(app.getTransaction.byId('nope')).rejects.toThrow(
        'not found',
      );
    });
  });
});
