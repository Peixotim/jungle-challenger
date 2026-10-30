import { randomUUID } from 'node:crypto';
import { DeleteMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { UnitOfWork } from '../../src/application/ports/UnitOfWork.js';
import { PublishOutbox } from '../../src/application/use-cases/PublishOutbox.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs/SqsEventPublisher.js';
import { SqsHealthIndicator } from '../../src/infrastructure/messaging/sqs/SqsHealthIndicator.js';
import { SqsConsumer } from '../../src/interface/sqs/SqsConsumer.js';
import { startTcpProxy } from '../support/tcp-proxy.js';
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
import { buildConsumer } from './support/consumer.js';
import {
  connectTestDatabase,
  TestDatabase,
  testDatabaseUrl,
} from './support/database.js';
import {
  drain,
  purgeAll,
  QUEUES,
  queueDepth,
  sendMessage,
  setVisibilityTimeout,
  testSqsClient,
  wagerMessage,
  waitFor,
} from './support/sqs.js';

describe('SQS (real LocalStack and PostgreSQL)', () => {
  let db: TestDatabase;
  let app: App;
  let sqs: SQSClient;
  const consumers: SqsConsumer[] = [];

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

  const track = (consumer: SqsConsumer) => {
    consumers.push(consumer);
    return consumer;
  };

  const queuesIdle = async () => {
    const depth = await queueDepth(sqs, QUEUES.requests);
    return depth.visible === 0 && depth.inFlight === 0;
  };

  beforeAll(async () => {
    db = await connectTestDatabase();
    sqs = testSqsClient();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    await purgeAll(sqs);
    app = buildApp(db);
  });

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((consumer) => consumer.stop()));
    await setVisibilityTimeout(sqs, QUEUES.requests, 30);
  });

  describe('consuming wager transactions', () => {
    it('applies a message, commits, and only then acknowledges it', async () => {
      const wallet = await openWallet(app);
      await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);

      track(buildConsumer(app, sqs)).start();

      await waitFor(
        async () => (await walletBalance(app, wallet)) === '975.00',
        {
          label: 'the wallet to be debited',
        },
      );
      await waitFor(queuesIdle, { label: 'the message to be acknowledged' });
      expect(await count('inbox_messages', 'processed_at is not null')).toBe(1);
      expect(await count('wager_transactions', "kind = 'BET'")).toBe(1);
      await expectConsistent(app, wallet);
    });

    it('does not trust FIFO deduplication: the same business message sent twice has one effect', async () => {
      const wallet = await openWallet(app);
      const message = wagerMessage(wallet);
      await sendMessage(sqs, QUEUES.requests, message, wallet.id);
      await sendMessage(sqs, QUEUES.requests, message, wallet.id);
      await sendMessage(
        sqs,
        QUEUES.requests,
        { ...message, messageId: `another-${randomUUID()}` },
        wallet.id,
      );

      track(buildConsumer(app, sqs)).start();

      await waitFor(queuesIdle, { label: 'all copies to be consumed' });
      expect(await walletBalance(app, wallet)).toBe('975.00');
      expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(
        1,
      );
      await expectConsistent(app, wallet);
    });

    it('survives a worker that dies after the commit and before the ack: redelivery changes nothing', async () => {
      await setVisibilityTimeout(sqs, QUEUES.requests, 1);
      const wallet = await openWallet(app);
      let lostAcks = 1;
      const dyingAckClient = {
        send: (command: unknown, ...rest: unknown[]) => {
          if (command instanceof DeleteMessageCommand && lostAcks > 0) {
            lostAcks -= 1;
            return Promise.reject(new Error('worker died before the ack'));
          }
          return (sqs.send as (...args: unknown[]) => Promise<unknown>)(
            command,
            ...rest,
          );
        },
      } as unknown as SQSClient;
      await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);

      track(buildConsumer(app, dyingAckClient)).start();

      await waitFor(async () => lostAcks === 0, {
        label: 'the first ack to be lost',
      });
      await waitFor(queuesIdle, {
        timeoutMs: 30_000,
        label: 'the redelivered message to be acked',
      });
      expect(await walletBalance(app, wallet)).toBe('975.00');
      expect(await count('wager_transactions', "kind = 'BET'")).toBe(1);
      expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(
        1,
      );
      expect(app.metrics.count('wager_duplicates_total')).toBe(1);
      await expectConsistent(app, wallet);
    });

    it('acknowledges a business rejection instead of retrying it', async () => {
      const wallet = await openWallet(app, '10.00');
      await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);

      track(buildConsumer(app, sqs)).start();

      await waitFor(queuesIdle, { label: 'the rejected message to be acked' });
      const [tx] = await db.query<{ status: string; failure_code: string }>(
        "select status, failure_code from wager_transactions where kind = 'BET'",
      );
      expect(tx).toEqual({
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
      });
      expect(await walletBalance(app, wallet)).toBe('10.00');
      expect(await drain(sqs, QUEUES.dlq)).toHaveLength(0);
    });
  });

  describe('permanent failures', () => {
    const deadLetters = async () => {
      await waitFor(
        async () => {
          const depth = await queueDepth(sqs, QUEUES.dlq);
          return depth.visible + depth.inFlight > 0;
        },
        { label: 'a message in the dead-letter queue' },
      );
      return drain(sqs, QUEUES.dlq);
    };

    it.each([
      ['a body that is not JSON', 'this is not json', 'MALFORMED'],
      [
        'a schema violation',
        (w: OpenedWallet) => wagerMessage(w, {}, { kind: 'OPENING' }),
        'MALFORMED',
      ],
      [
        'an invalid amount',
        (w: OpenedWallet) => wagerMessage(w, {}, { money: money('25.001') }),
        'INVALID',
      ],
    ])(
      '%s is dead-lettered as %s without touching the wallet',
      async (_name, build, reason) => {
        const wallet = await openWallet(app);
        const body = typeof build === 'function' ? build(wallet) : build;
        await sendMessage(sqs, QUEUES.requests, body, wallet.id);

        track(buildConsumer(app, sqs)).start();

        const [dead] = await deadLetters();
        expect(dead.MessageAttributes?.deadLetterReason?.StringValue).toBe(
          reason,
        );
        expect(
          dead.MessageAttributes?.originalMessageId?.StringValue,
        ).toBeTruthy();
        expect(dead.Body).toBe(
          typeof body === 'string' ? body : JSON.stringify(body),
        );
        await waitFor(queuesIdle, { label: 'the main queue to be empty' });
        expect(await walletBalance(app, wallet)).toBe('1000.00');
        expect(app.metrics.counters).toContainEqual({
          name: 'sqs_dlq_messages_total',
          labels: { reason },
        });
      },
    );

    it('an idempotency key reused with different content is dead-lettered and leaves the first effect intact', async () => {
      const wallet = await openWallet(app);
      const first = wagerMessage(wallet);
      const conflicting = wagerMessage(
        wallet,
        {},
        {
          externalTransactionId: first.data.externalTransactionId,
          money: money('99.00'),
        },
      );
      await sendMessage(sqs, QUEUES.requests, first, wallet.id);
      track(buildConsumer(app, sqs)).start();
      await waitFor(
        async () => (await walletBalance(app, wallet)) === '975.00',
      );

      await sendMessage(sqs, QUEUES.requests, conflicting, wallet.id);

      const [dead] = await deadLetters();
      expect(dead.MessageAttributes?.deadLetterReason?.StringValue).toBe(
        'CONFLICT',
      );
      expect(await walletBalance(app, wallet)).toBe('975.00');
    });
  });

  describe('transient failures', () => {
    async function withDatabaseBehindProxy<T>(
      work: (
        proxy: Awaited<ReturnType<typeof startTcpProxy>>,
        flaky: App,
      ) => Promise<T>,
    ): Promise<T> {
      const target = new URL(testDatabaseUrl());
      const proxy = await startTcpProxy(target.hostname, Number(target.port));
      const viaProxy = new URL(target);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.port);
      const flakyDb = await connectTestDatabase(viaProxy.toString());
      try {
        return await work(proxy, buildApp(flakyDb));
      } finally {
        await proxy.close();
        await flakyDb.close();
      }
    }

    it('retries while the database is down and applies the message once when it returns', async () => {
      const wallet = await openWallet(app);
      await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);

      await withDatabaseBehindProxy(async (proxy, flaky) => {
        await proxy.cut();
        track(
          buildConsumer(flaky, sqs, { maxAttempts: 5, retryBaseSeconds: 1 }),
        ).start();

        await waitFor(() => flaky.metrics.count('sqs_retries_total') >= 2, {
          label: 'retries while the database is unreachable',
        });
        expect(await walletBalance(app, wallet)).toBe('1000.00');

        await proxy.restore();

        await waitFor(
          async () => (await walletBalance(app, wallet)) === '975.00',
          {
            label: 'the message to be applied after recovery',
          },
        );
      });

      await waitFor(queuesIdle, { label: 'the message to be acked' });
      expect(await count('wager_transactions', "kind = 'BET'")).toBe(1);
      expect(await drain(sqs, QUEUES.dlq)).toHaveLength(0);
      await expectConsistent(app, wallet);
    });

    it('dead-letters the message after the attempt limit, with nothing applied', async () => {
      const wallet = await openWallet(app);
      await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);

      await withDatabaseBehindProxy(async (proxy, flaky) => {
        await proxy.cut();
        track(
          buildConsumer(flaky, sqs, { maxAttempts: 3, retryBaseSeconds: 0 }),
        ).start();

        await waitFor(
          async () => {
            const depth = await queueDepth(sqs, QUEUES.dlq);
            return depth.visible + depth.inFlight > 0;
          },
          { label: 'the exhausted message in the dead-letter queue' },
        );
      });

      const [dead] = await drain(sqs, QUEUES.dlq);
      expect(dead.MessageAttributes?.deadLetterReason?.StringValue).toBe(
        'RETRIES_EXHAUSTED',
      );
      expect(dead.MessageAttributes?.receiveCount?.StringValue).toBe('3');
      expect(await walletBalance(app, wallet)).toBe('1000.00');
      expect(await count('wager_transactions', "kind = 'BET'")).toBe(0);
    });
  });

  describe('shutdown and scale', () => {
    it('finishes what it is processing, releases the rest, and a second consumer completes the work exactly once', async () => {
      const wallet = await openWallet(app, '1000.00');
      for (let i = 0; i < 6; i++) {
        await sendMessage(
          sqs,
          QUEUES.requests,
          wagerMessage(wallet),
          wallet.id,
        );
      }
      const first = track(buildConsumer(app, sqs, { handlerDelayMs: 400 }));
      first.start();
      await waitFor(
        () => count('wager_transactions', "kind = 'BET'").then((n) => n >= 1),
        {
          label: 'the first message to be processed',
        },
      );

      await first.stop();

      const processedByFirst = await count(
        'wager_transactions',
        "kind = 'BET'",
      );
      expect(processedByFirst).toBeLessThan(6);
      expect(app.metrics.counters).toContainEqual({
        name: 'sqs_messages_total',
        labels: { outcome: 'released' },
      });

      track(buildConsumer(app, sqs)).start();
      await waitFor(queuesIdle, {
        label: 'the remaining messages to be consumed',
      });
      expect(await count('wager_transactions', "kind = 'BET'")).toBe(6);
      expect(await walletBalance(app, wallet)).toBe('850.00');
      await expectConsistent(app, wallet);
    });

    it('three consumers share 60 messages across 6 wallets with exact balances', async () => {
      const wallets = await Promise.all(
        Array.from({ length: 6 }, () => openWallet(app)),
      );
      for (const wallet of wallets) {
        for (let i = 0; i < 10; i++) {
          await sendMessage(
            sqs,
            QUEUES.requests,
            wagerMessage(wallet),
            wallet.id,
          );
        }
      }

      for (let i = 0; i < 3; i++)
        track(buildConsumer(buildApp(db), sqs)).start();

      await waitFor(
        async () =>
          (await count('wager_transactions', "kind = 'BET'")) === 60 &&
          (await queuesIdle()),
        { timeoutMs: 60_000, label: 'all 60 messages to be consumed' },
      );
      for (const wallet of wallets) {
        expect(await walletBalance(app, wallet)).toBe('750.00');
        await expectConsistent(app, wallet);
      }
    });

    it('one wallet under three consumers: a hot wallet never goes negative and never double-spends', async () => {
      const wallet = await openWallet(app, '50.00');
      for (let i = 0; i < 80; i++) {
        await sendMessage(
          sqs,
          QUEUES.requests,
          wagerMessage(wallet, {}, { money: money('1.00') }),
          wallet.id,
        );
      }

      for (let i = 0; i < 3; i++)
        track(buildConsumer(buildApp(db), sqs)).start();

      await waitFor(
        async () =>
          (await count('wager_transactions', "kind = 'BET'")) === 80 &&
          (await queuesIdle()),
        { timeoutMs: 60_000, label: 'all 80 messages to be consumed' },
      );
      expect(await walletBalance(app, wallet)).toBe('0.00');
      expect(
        await count(
          'wager_transactions',
          "status = 'PROCESSED' and kind = 'BET'",
        ),
      ).toBe(50);
      expect(await count('wager_transactions', "status = 'REJECTED'")).toBe(30);
      await expectConsistent(app, wallet);
    });
  });

  describe('publishing events', () => {
    const publisherFor = (uow: UnitOfWork = app.uow) =>
      new PublishOutbox(
        uow,
        new SqsEventPublisher(sqs, QUEUES.events),
        app.clock,
        app.metrics,
        app.logger,
      );

    it('delivers every outbox event to the events queue with its envelope and attributes', async () => {
      const wallet = await openWallet(app);
      await app.submit.execute(operation(wallet));

      expect(await publisherFor().execute()).toEqual({
        published: 4,
        failed: 0,
      });

      const events = await drain(sqs, QUEUES.events);
      expect(events).toHaveLength(4);
      const types = events
        .map((e) => e.MessageAttributes?.eventType?.StringValue)
        .sort();
      expect(types).toEqual([
        'WagerTransactionProcessed',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WalletBalanceChanged',
      ]);
      const balanceChanged = events.find(
        (e) =>
          e.MessageAttributes?.eventType?.StringValue ===
          'WalletBalanceChanged',
      )!;
      expect(JSON.parse(balanceChanged.Body!)).toMatchObject({
        eventType: 'WalletBalanceChanged',
        version: 1,
        data: { walletId: wallet.id },
      });
      expect(balanceChanged.Attributes?.MessageGroupId).toBe(wallet.id);
      expect(await count('outbox_messages', 'published_at is null')).toBe(0);
    });

    it('a publisher that dies after sending and before committing causes no duplicate in the queue', async () => {
      const wallet = await openWallet(app);
      await app.submit.execute(operation(wallet));
      const dying: UnitOfWork = {
        run: (work) =>
          app.uow.run(async (ctx) => {
            await work(ctx);
            throw new Error('process died after the broker accepted the batch');
          }),
      };

      await expect(publisherFor(dying).execute()).rejects.toThrow(
        'process died',
      );
      expect(await count('outbox_messages', 'published_at is null')).toBe(4);

      expect(await publisherFor().execute()).toEqual({
        published: 4,
        failed: 0,
      });

      const events = await drain(sqs, QUEUES.events);
      expect(events).toHaveLength(4);
      expect(
        new Set(events.map((e) => e.MessageAttributes?.eventId?.StringValue))
          .size,
      ).toBe(4);
    });
  });

  describe('health', () => {
    it('is up when the queues exist and down when one does not', async () => {
      const healthy = new SqsHealthIndicator(sqs, [
        QUEUES.requests,
        QUEUES.events,
      ]);
      await expect(healthy.check()).resolves.toBeUndefined();

      const broken = new SqsHealthIndicator(sqs, [
        QUEUES.requests,
        `${QUEUES.requests}-does-not-exist`,
      ]);
      await expect(broken.check()).rejects.toThrow();
    });
  });
});
