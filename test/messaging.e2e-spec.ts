import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  connectTestDatabase,
  TestDatabase,
  testDatabaseUrl,
} from './integration/support/database.js';
import {
  drain,
  purgeAll,
  QUEUES,
  queueDepth,
  sendMessage,
  testSqsClient,
  wagerMessage,
  waitFor,
} from './integration/support/sqs.js';
import { startApp } from './support/start-app.js';
import { applicationTestEnv } from './support/test-env.js';

const money = (amount: string) => ({ amount, currency: 'BRL' });

describe('messaging pipeline with consumer and workers enabled (e2e)', () => {
  const originalEnv = { ...process.env };
  let db: TestDatabase;
  let sqs: SQSClient;
  let app: NestExpressApplication | undefined;

  const http = () => request(app!.getHttpServer());

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
    process.env = {
      ...originalEnv,
      ...applicationTestEnv(testDatabaseUrl(), {
        SQS_CONSUMER_ENABLED: 'true',
        WORKERS_ENABLED: 'true',
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_RETRY_BASE_SECONDS: '1',
        SQS_RETRY_MAX_SECONDS: '2',
        OUTBOX_INTERVAL_MS: '200',
        PENDING_REFERENCE_INTERVAL_MS: '200',
      }),
    };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = { ...originalEnv };
  });

  async function openWallet(balance = '1000.00') {
    const playerId = randomUUID();
    const response = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: money(balance) })
      .expect(201);
    return { id: response.body.id as string, playerId };
  }

  const balanceOf = async (walletId: string) =>
    (await http().get(`/wallets/${walletId}`)).body.balance?.amount as string;

  const collectEvents = async (minimum: number) => {
    const events: { eventType: string; data: Record<string, unknown> }[] = [];
    await waitFor(
      async () => {
        for (const message of await drain(sqs, QUEUES.events, {
          waitSeconds: 0,
        })) {
          events.push(JSON.parse(message.Body!));
        }
        return events.length >= minimum;
      },
      { label: `${minimum} events on the events queue` },
    );
    return events;
  };

  it('moves money from a queue message and publishes the resulting events', async () => {
    app = await startApp();
    const wallet = await openWallet();

    await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);

    await waitFor(async () => (await balanceOf(wallet.id)) === '975.00', {
      label: 'the wallet to be debited by the consumer',
    });
    const events = await collectEvents(4);
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    const debit = events.find(
      (e) =>
        e.eventType === 'WalletBalanceChanged' && e.data.direction === 'DEBIT',
    );
    expect(debit?.data).toMatchObject({
      walletId: wallet.id,
      money: money('25.00'),
      balanceBefore: money('1000.00'),
      balanceAfter: money('975.00'),
      walletVersion: 2,
    });
    expect(
      (await http().post(`/wallets/${wallet.id}/reconciliation`)).body
        .consistent,
    ).toBe(true);
  });

  it('resolves a reference that arrives out of order through the background worker', async () => {
    app = await startApp();
    const wallet = await openWallet();
    const bet = wagerMessage(wallet);
    const refund = wagerMessage(
      wallet,
      {},
      {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.data.externalTransactionId,
      },
    );

    await sendMessage(sqs, QUEUES.requests, refund, wallet.id);
    await waitFor(
      async () =>
        (
          await http().get(
            `/providers/provider-a/wagering/transactions/${refund.data.externalTransactionId}`,
          )
        ).body.status === 'PENDING_REFERENCE',
      { label: 'the refund to be parked' },
    );
    await sendMessage(sqs, QUEUES.requests, bet, wallet.id);

    await waitFor(
      async () =>
        (
          await http().get(
            `/providers/provider-a/wagering/transactions/${refund.data.externalTransactionId}`,
          )
        ).body.status === 'PROCESSED',
      { timeoutMs: 30_000, label: 'the worker to complete the refund' },
    );
    expect(await balanceOf(wallet.id)).toBe('1000.00');
    const events = await collectEvents(7);
    expect(events.map((e) => e.eventType)).toContain(
      'WagerTransactionPendingReference',
    );
    expect(
      (await http().post(`/wallets/${wallet.id}/reconciliation`)).body
        .consistent,
    ).toBe(true);
  });

  it('dead-letters a poison message while the service keeps working', async () => {
    app = await startApp();
    const wallet = await openWallet();

    await sendMessage(
      sqs,
      QUEUES.requests,
      '{"definitely": not json',
      wallet.id,
    );
    await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);

    await waitFor(async () => (await balanceOf(wallet.id)) === '975.00', {
      label: 'the valid message behind the poison one',
    });
    await waitFor(async () => (await queueDepth(sqs, QUEUES.dlq)).visible > 0, {
      label: 'the poison message in the dead-letter queue',
    });
    const [dead] = await drain(sqs, QUEUES.dlq);
    expect(dead.MessageAttributes?.deadLetterReason?.StringValue).toBe(
      'MALFORMED',
    );
  });

  it('reports SQS in readiness and exposes consumer and worker metrics', async () => {
    app = await startApp();
    const wallet = await openWallet();
    await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);
    await waitFor(async () => (await balanceOf(wallet.id)) === '975.00');

    const ready = await http().get('/health/ready').expect(200);
    expect(ready.body.checks).toMatchObject({
      postgres: { status: 'up' },
      sqs: { status: 'up' },
    });

    const expected = [
      'sqs_messages_total{outcome="processed"} 1',
      'worker_ticks_total{task="outbox-publisher"}',
      'worker_ticks_total{task="pending-reference"}',
      'outbox_lag_seconds_count',
    ];
    let metrics = '';
    await waitFor(
      async () => {
        metrics = (await http().get('/metrics')).text;
        return expected.every((line) => metrics.includes(line));
      },
      { label: 'consumer and worker metrics to be recorded' },
    );
    for (const line of expected) expect(metrics).toContain(line);
  });

  it('shuts down promptly, and a stopped service no longer consumes the queue', async () => {
    app = await startApp();
    const wallet = await openWallet();
    await waitFor(async () => (await balanceOf(wallet.id)) === '1000.00');

    const startedAt = Date.now();
    await app.close();
    app = undefined;
    expect(Date.now() - startedAt).toBeLessThan(8_000);

    await sendMessage(sqs, QUEUES.requests, wagerMessage(wallet), wallet.id);
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const depth = await queueDepth(sqs, QUEUES.requests);
    expect(depth.visible).toBe(1);
    expect(depth.inFlight).toBe(0);
  });
});
