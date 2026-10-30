import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
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
  setVisibilityTimeout,
  testSqsClient,
  wagerMessage,
  waitFor,
} from './integration/support/sqs.js';
import { Instance, startInstance } from './support/process-cluster.js';
import { applicationTestEnv } from './support/test-env.js';

const money = (amount: string) => ({ amount, currency: 'BRL' });
const INSTANCES = 3;

describe('three real service processes sharing PostgreSQL and SQS (e2e)', () => {
  let db: TestDatabase;
  let sqs: SQSClient;
  let instances: Instance[] = [];

  const environment = () =>
    applicationTestEnv(testDatabaseUrl(), {
      LOG_LEVEL: 'warn',
      SQS_CONSUMER_ENABLED: 'true',
      WORKERS_ENABLED: 'true',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_RETRY_BASE_SECONDS: '1',
      SQS_RETRY_MAX_SECONDS: '2',
      OUTBOX_INTERVAL_MS: '200',
      PENDING_REFERENCE_INTERVAL_MS: '500',
      DATABASE_POOL_MAX: '8',
    });

  const live = () => instances.filter((instance) => instance.isRunning());

  const post = (
    instance: Instance,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${instance.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
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

  const createWallet = async (balance: string) => {
    const playerId = randomUUID();
    const response = await post(instances[0], '/wallets', {
      playerId,
      initialBalance: money(balance),
    });
    expect(response.status).toBe(201);
    return { id: ((await response.json()) as { id: string }).id, playerId };
  };

  const balanceOf = async (walletId: string) => {
    const [row] = await db.query<{ balance: string }>(
      'select balance from wallets where id = ?',
      [walletId],
    );
    return row.balance;
  };

  const httpBet = (
    wallet: { id: string; playerId: string },
    over: Record<string, unknown> = {},
  ) => {
    const externalTransactionId = `ext-${randomUUID()}`;
    return {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: money('1.00'),
      ...over,
    };
  };

  const submitOverHttp = (
    instance: Instance,
    body: ReturnType<typeof httpBet>,
  ) =>
    post(instance, '/wagering/transactions', body, {
      'Idempotency-Key': `provider-a:${body.externalTransactionId}`,
    });

  const requestsQueueIdle = async () => {
    const depth = await queueDepth(sqs, QUEUES.requests);
    return depth.visible === 0 && depth.inFlight === 0;
  };

  const expectCoherentLedger = async (walletId: string) => {
    const response = await fetch(
      `${live()[0].url}/wallets/${walletId}/reconciliation`,
      {
        method: 'POST',
      },
    );
    expect(await response.json()).toMatchObject({ consistent: true });
    expect(await count('wallets', 'balance < 0')).toBe(0);
  };

  beforeAll(async () => {
    db = await connectTestDatabase();
    sqs = testSqsClient();
    await db.reset();
    await purgeAll(sqs);
    await setVisibilityTimeout(sqs, QUEUES.requests, 3);
    instances = await Promise.all(
      Array.from({ length: INSTANCES }, () => startInstance(environment())),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.kill()));
    await setVisibilityTimeout(sqs, QUEUES.requests, 30);
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    await purgeAll(sqs);
  });

  it('starts three distinct processes, all healthy', async () => {
    expect(new Set(instances.map((instance) => instance.pid)).size).toBe(
      INSTANCES,
    );
    for (const instance of instances) {
      const response = await fetch(`${instance.url}/health/ready`);
      expect(response.status).toBe(200);
    }
  });

  it('a hot wallet fed by HTTP on all three and by SQS never goes negative nor double-spends', async () => {
    const wallet = await createWallet('100.00');
    const queued = Array.from({ length: 150 }, () =>
      wagerMessage(wallet, {}, { money: money('1.00') }),
    );
    const direct = Array.from({ length: 100 }, () => httpBet(wallet));

    await Promise.all([
      ...queued.map((message) =>
        sendMessage(sqs, QUEUES.requests, message, wallet.id),
      ),
      ...direct.map((body, index) =>
        submitOverHttp(instances[index % INSTANCES], body),
      ),
    ]);

    await waitFor(
      async () =>
        (await count('wager_transactions', "kind = 'BET'")) === 250 &&
        (await requestsQueueIdle()),
      {
        timeoutMs: 90_000,
        label: 'all 250 bets to be decided',
      },
    );
    expect(
      await count(
        'wager_transactions',
        "status = 'PROCESSED' and kind = 'BET'",
      ),
    ).toBe(100);
    expect(
      await count('wager_transactions', "status = 'REJECTED' and kind = 'BET'"),
    ).toBe(150);
    expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(
      100,
    );
    expect(await balanceOf(wallet.id)).toBe('0.00');
    await expectCoherentLedger(wallet.id);
  }, 120_000);

  it('the same BET sent 70 times, over HTTP to every process and over SQS, is debited once', async () => {
    const wallet = await createWallet('1000.00');
    const bet = httpBet(wallet, { money: money('25.00') });
    const sameOverSqs = () =>
      wagerMessage(
        wallet,
        {},
        {
          externalTransactionId: bet.externalTransactionId,
          money: money('25.00'),
        },
      );

    await Promise.all([
      ...Array.from({ length: 50 }, (_, index) =>
        submitOverHttp(instances[index % INSTANCES], bet),
      ),
      ...Array.from({ length: 20 }, () =>
        sendMessage(sqs, QUEUES.requests, sameOverSqs(), wallet.id),
      ),
    ]);

    await waitFor(requestsQueueIdle, {
      timeoutMs: 60_000,
      label: 'the duplicates to be consumed',
    });
    expect(await count('wager_transactions', "kind = 'BET'")).toBe(1);
    expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    await expectCoherentLedger(wallet.id);
  }, 120_000);

  it('survives a process killed with SIGKILL mid-flight: every message is applied exactly once', async () => {
    const wallet = await createWallet('1000.00');
    const total = 300;
    for (let batch = 0; batch < total; batch += 50) {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          sendMessage(
            sqs,
            QUEUES.requests,
            wagerMessage(wallet, {}, { money: money('1.00') }),
            wallet.id,
          ),
        ),
      );
    }

    await waitFor(
      async () => (await count('wager_transactions', "kind = 'BET'")) >= 40,
      {
        timeoutMs: 60_000,
        label: 'processing to be under way',
      },
    );
    const victim = instances[1];
    await victim.kill();
    expect(victim.isRunning()).toBe(false);
    expect(await count('wager_transactions', "kind = 'BET'")).toBeLessThan(
      total,
    );

    await waitFor(
      async () =>
        (await count('wager_transactions', "kind = 'BET'")) === total &&
        (await requestsQueueIdle()),
      {
        timeoutMs: 90_000,
        label: 'the surviving processes to finish every message',
      },
    );
    expect(
      await count(
        'wager_transactions',
        "status = 'PROCESSED' and kind = 'BET'",
      ),
    ).toBe(total);
    expect(await count('inbox_messages', 'processed_at is not null')).toBe(
      total,
    );
    expect(await count('wallet_ledger_entries', "direction = 'DEBIT'")).toBe(
      total,
    );
    expect(await balanceOf(wallet.id)).toBe('700.00');
    await expectCoherentLedger(wallet.id);

    instances[1] = await startInstance(environment());
    const restarted = await fetch(`${instances[1].url}/health/ready`);
    expect(restarted.status).toBe(200);
    const stillConsistent = await fetch(
      `${instances[1].url}/wallets/${wallet.id}`,
    );
    expect(
      ((await stillConsistent.json()) as { balance: { amount: string } })
        .balance.amount,
    ).toBe('700.00');
  }, 180_000);

  it('publishes every event exactly once at the queue, whichever process published it', async () => {
    const wallet = await createWallet('1000.00');
    for (let i = 0; i < 40; i++) {
      await submitOverHttp(instances[i % INSTANCES], httpBet(wallet));
    }

    await waitFor(
      async () =>
        (await count('outbox_messages', 'published_at is null')) === 0,
      {
        timeoutMs: 30_000,
        label: 'the outbox to drain',
      },
    );
    const published = await count('outbox_messages');
    const received = await drain(sqs, QUEUES.events, {
      waitSeconds: 2,
      maxRounds: 40,
    });
    const eventIds = received.map(
      (message) => message.MessageAttributes?.eventId?.StringValue,
    );

    expect(published).toBe(2 + 40 * 2);
    expect(new Set(eventIds).size).toBe(published);
    expect(eventIds).toHaveLength(published);
  }, 120_000);
});
