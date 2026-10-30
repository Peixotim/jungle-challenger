import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { LifecycleState } from '../src/infrastructure/lifecycle/LifecycleState.js';
import {
  connectTestDatabase,
  TestDatabase,
  testDatabaseUrl,
} from './integration/support/database.js';
import { startApp } from './support/start-app.js';
import { applicationTestEnv } from './support/test-env.js';
import { startTcpProxy } from './support/tcp-proxy.js';

const money = (amount: string) => ({ amount, currency: 'BRL' });

describe('HTTP API (e2e)', () => {
  const originalEnv = { ...process.env };
  let db: TestDatabase;
  let app: NestExpressApplication;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    process.env = { ...originalEnv, ...applicationTestEnv(testDatabaseUrl()) };
    app = await startApp();
  });

  afterEach(async () => {
    await app.close();
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

  interface Wallet {
    id: string;
    playerId: string;
  }

  const transaction = (wallet: Wallet, over: Record<string, unknown> = {}) => ({
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: money('25.00'),
    ...over,
  });

  const submit = (body: Record<string, unknown>, key?: string) =>
    http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', key ?? `provider-a:${body.externalTransactionId}`)
      .send(body);

  describe('wallets', () => {
    it('creates a wallet with the contract of the challenge', async () => {
      const playerId = randomUUID();

      const response = await http()
        .post('/wallets')
        .send({ playerId, initialBalance: money('1000.00') })
        .expect(201);

      expect(response.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        playerId,
        balance: money('1000.00'),
        version: 1,
      });
    });

    it('answers a duplicate wallet for the same player and currency with 409', async () => {
      const wallet = await openWallet();

      const response = await http()
        .post('/wallets')
        .send({ playerId: wallet.playerId, initialBalance: money('5.00') })
        .expect(409);

      expect(response.body).toMatchObject({
        code: 'WALLET_ALREADY_EXISTS',
        status: 409,
      });
    });

    it('answers 10 concurrent creations for one player with a single 201', async () => {
      const playerId = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          http()
            .post('/wallets')
            .send({ playerId, initialBalance: money('10.00') }),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(9);
    });

    it('rejects an invalid shape with field-level errors', async () => {
      const response = await http()
        .post('/wallets')
        .send({ playerId: 'not-a-uuid', initialBalance: { amount: 10 } })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.errors.map((e: { path: string }) => e.path)).toEqual(
        expect.arrayContaining(['body.playerId', 'body.initialBalance.amount']),
      );
    });

    it.each(['-1.00', '1.001', '1e3', 'NaN', ''])(
      'rejects the invalid amount %j as INVALID_MONEY',
      async (amount) => {
        const response = await http()
          .post('/wallets')
          .send({ playerId: randomUUID(), initialBalance: money(amount) })
          .expect(400);

        expect(response.body.code).toBe('INVALID_MONEY');
      },
    );

    it('reads a wallet, and answers 404 for unknown or malformed ids', async () => {
      const wallet = await openWallet('42.50');

      const found = await http().get(`/wallets/${wallet.id}`).expect(200);
      expect(found.body).toEqual({
        id: wallet.id,
        playerId: wallet.playerId,
        balance: money('42.50'),
        version: 1,
      });

      const missing = await http().get(`/wallets/${randomUUID()}`).expect(404);
      expect(missing.body.code).toBe('WALLET_NOT_FOUND');
      await http().get('/wallets/not-a-uuid').expect(404);
    });

    it('pages the ledger with an opaque cursor', async () => {
      const wallet = await openWallet('1000.00');
      for (let i = 0; i < 4; i++) await submit(transaction(wallet)).expect(200);

      const first = await http()
        .get(`/wallets/${wallet.id}/ledger?limit=3`)
        .expect(200);
      expect(first.body.entries).toHaveLength(3);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      expect(first.body.entries[0]).toMatchObject({
        direction: 'CREDIT',
        balanceBefore: money('0.00'),
        balanceAfter: money('1000.00'),
      });

      const second = await http()
        .get(`/wallets/${wallet.id}/ledger`)
        .query({ limit: 3, cursor: first.body.nextCursor })
        .expect(200);
      expect(second.body.entries).toHaveLength(2);
      expect(second.body.nextCursor).toBeUndefined();
      expect(second.body.entries[1]).toMatchObject({
        direction: 'DEBIT',
        balanceAfter: money('900.00'),
      });
    });

    it('validates the ledger query', async () => {
      const wallet = await openWallet();

      const badLimit = await http()
        .get(`/wallets/${wallet.id}/ledger?limit=0`)
        .expect(400);
      expect(badLimit.body.code).toBe('VALIDATION_ERROR');

      const badCursor = await http()
        .get(`/wallets/${wallet.id}/ledger?cursor=%21%21%21`)
        .expect(400);
      expect(badCursor.body.code).toBe('INVALID_QUERY');

      await http().get(`/wallets/${randomUUID()}/ledger`).expect(404);
    });

    it('reconciles a wallet: consistent after movements', async () => {
      const wallet = await openWallet('1000.00');
      await submit(transaction(wallet)).expect(200);

      const response = await http()
        .post(`/wallets/${wallet.id}/reconciliation`)
        .expect(200);

      expect(response.body).toEqual({
        walletId: wallet.id,
        storedBalance: money('975.00'),
        calculatedBalance: money('975.00'),
        difference: money('0.00'),
        consistent: true,
        checkedEntries: 2,
      });
      await http().post(`/wallets/${randomUUID()}/reconciliation`).expect(404);
    });
  });

  describe('POST /wagering/transactions', () => {
    it('processes a BET with the contract of the challenge', async () => {
      const wallet = await openWallet();

      const response = await submit(transaction(wallet)).expect(200);

      expect(response.body).toEqual({
        transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        status: 'PROCESSED',
        balance: money('975.00'),
        idempotentReplay: false,
      });
    });

    it('replays the same request with the original answer and idempotentReplay=true', async () => {
      const wallet = await openWallet();
      const body = transaction(wallet);
      const first = await submit(body).expect(200);
      await submit(transaction(wallet)).expect(200);

      const replay = await submit(body).expect(200);

      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(replay.body.balance).toEqual(money('975.00'));
    });

    it('requires the Idempotency-Key header', async () => {
      const wallet = await openWallet();

      const response = await http()
        .post('/wagering/transactions')
        .send(transaction(wallet))
        .expect(400);

      expect(response.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        errors: [
          { path: 'header', message: 'the Idempotency-Key header is required' },
        ],
      });
    });

    it('answers the same key with another payload as a 409 conflict, never a replay', async () => {
      const wallet = await openWallet();
      const body = transaction(wallet);
      await submit(body).expect(200);

      const conflict = await submit({ ...body, money: money('30.00') }).expect(
        409,
      );

      expect(conflict.body.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
      const otherKey = await submit(body, 'another-key').expect(409);
      expect(otherKey.body.code).toBe('IDEMPOTENCY_EXTERNAL_ID_REUSED');
    });

    it('answers a business rejection with 422 and the failure code, also on replay', async () => {
      const wallet = await openWallet('10.00');
      const body = transaction(wallet);

      const first = await submit(body).expect(422);
      const replay = await submit(body).expect(422);

      expect(first.body).toEqual({
        transactionId: expect.any(String),
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: money('10.00'),
        idempotentReplay: false,
      });
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('answers a missing reference with 202 and keeps the transaction pending', async () => {
      const wallet = await openWallet();

      const response = await submit(
        transaction(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: 'bet-not-yet-here',
        }),
      ).expect(202);

      expect(response.body.status).toBe('PENDING_REFERENCE');
      const stored = await http()
        .get(`/wagering/transactions/${response.body.transactionId}`)
        .expect(200);
      expect(stored.body.status).toBe('PENDING_REFERENCE');
      expect((await http().get(`/wallets/${wallet.id}`)).body.balance).toEqual(
        money('1000.00'),
      );
    });

    it('refunds a BET once; a second refund is rejected as already reversed', async () => {
      const wallet = await openWallet();
      const bet = transaction(wallet);
      await submit(bet).expect(200);
      const refund = (external: string) =>
        submit(
          transaction(wallet, {
            kind: 'REFUND',
            externalTransactionId: external,
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        );

      const first = await refund('refund-1').expect(200);
      const second = await refund('refund-2').expect(422);

      expect(first.body.balance).toEqual(money('1000.00'));
      expect(second.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'ALREADY_REVERSED',
      });
    });

    it('rejects the internal OPENING kind and unknown properties', async () => {
      const wallet = await openWallet();

      const opening = await submit(
        transaction(wallet, { kind: 'OPENING' }),
      ).expect(400);
      expect(opening.body.errors[0].path).toBe('body.kind');
      await submit(transaction(wallet, { surprise: true })).expect(400);
    });

    it('persists a rejection for an unknown wallet instead of failing the request', async () => {
      const wallet = await openWallet();

      const response = await submit(
        transaction(wallet, { walletId: randomUUID() }),
      ).expect(422);

      expect(response.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'WALLET_NOT_FOUND',
      });
    });

    it('debits exactly once when the same request is sent 20 times in parallel', async () => {
      const wallet = await openWallet();
      const body = transaction(wallet);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => submit(body)),
      );

      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
      expect((await http().get(`/wallets/${wallet.id}`)).body.balance).toEqual(
        money('975.00'),
      );
      expect(
        (await http().post(`/wallets/${wallet.id}/reconciliation`)).body
          .consistent,
      ).toBe(true);
    });

    it('two parallel BETs of 80 on a balance of 100: one 200, one 422', async () => {
      const wallet = await openWallet('100.00');

      const responses = await Promise.all([
        submit(transaction(wallet, { money: money('80.00') })),
        submit(transaction(wallet, { money: money('80.00') })),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
      expect((await http().get(`/wallets/${wallet.id}`)).body.balance).toEqual(
        money('20.00'),
      );
    });
  });

  describe('transaction queries', () => {
    it('reads a transaction by internal id and by provider transaction id', async () => {
      const wallet = await openWallet();
      const body = transaction(wallet);
      const created = await submit(body).expect(200);

      const byId = await http()
        .get(`/wagering/transactions/${created.body.transactionId}`)
        .expect(200);
      const byExternal = await http()
        .get(
          `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
        )
        .expect(200);

      expect(byExternal.body).toEqual(byId.body);
      expect(byId.body).toMatchObject({
        transactionId: created.body.transactionId,
        status: 'PROCESSED',
        kind: 'BET',
        money: money('25.00'),
        balance: money('975.00'),
      });
    });

    it('answers 404 for unknown transactions', async () => {
      const byId = await http()
        .get(`/wagering/transactions/${randomUUID()}`)
        .expect(404);
      expect(byId.body.code).toBe('TRANSACTION_NOT_FOUND');
      await http()
        .get('/providers/provider-a/wagering/transactions/nope')
        .expect(404);
    });
  });

  describe('operations', () => {
    it('answers liveness and readiness', async () => {
      await http().get('/health/live').expect(200, { status: 'up' });

      const ready = await http().get('/health/ready').expect(200);
      expect(ready.body).toMatchObject({
        status: 'up',
        checks: { postgres: { status: 'up' } },
      });
    });

    it('turns readiness to 503 as soon as shutdown starts, while liveness stays up', async () => {
      app.get(LifecycleState).markShuttingDown();

      const ready = await http().get('/health/ready').expect(503);
      expect(ready.body).toEqual({ status: 'shutting_down', checks: {} });
      await http().get('/health/live').expect(200);
    });

    it('does not require authentication on the health endpoints', async () => {
      await http().get('/health/live').expect(200);
      await http().get('/health/ready').expect(200);
    });

    it('exposes Prometheus metrics for transactions, requests and duplicates', async () => {
      const wallet = await openWallet();
      const body = transaction(wallet);
      await submit(body).expect(200);
      await submit(body).expect(200);
      await submit(transaction(wallet, { money: money('5000.00') })).expect(
        422,
      );

      const response = await http().get('/metrics').expect(200);

      expect(response.headers['content-type']).toMatch(
        /text\/plain; version=0\.0\.4/,
      );
      expect(response.text).toContain(
        'wager_transactions_total{kind="BET",status="PROCESSED"} 1',
      );
      expect(response.text).toContain(
        'wager_transactions_total{kind="BET",status="REJECTED"} 1',
      );
      expect(response.text).toContain('wager_duplicates_total{kind="BET"} 1');
      expect(response.text).toContain(
        'http_requests_total{method="POST",route="/wagering/transactions",status="422"} 1',
      );
      expect(response.text).toMatch(
        /wager_processing_seconds_count\{kind="BET"\} 3/,
      );
    });

    it('carries the correlation id through success and error responses', async () => {
      const ok = await http()
        .get('/health/live')
        .set('X-Correlation-Id', 'provider-a:req-7')
        .expect(200);
      expect(ok.headers['x-correlation-id']).toBe('provider-a:req-7');

      const error = await http()
        .get(`/wallets/${randomUUID()}`)
        .set('X-Correlation-Id', 'provider-a:req-8')
        .expect(404);
      expect(error.body.correlationId).toBe('provider-a:req-8');
      expect(error.headers['content-type']).toMatch(
        /application\/problem\+json/,
      );
    });

    it('answers 503 with Retry-After when the database is gone, and reports it on readiness', async () => {
      await app.close();
      const target = new URL(testDatabaseUrl());
      const proxy = await startTcpProxy(target.hostname, Number(target.port));
      const viaProxy = new URL(target);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.port);
      process.env.DATABASE_URL = viaProxy.toString();
      app = await startApp();

      try {
        await proxy.cut();

        const failed = await http()
          .post('/wallets')
          .send({ playerId: randomUUID(), initialBalance: money('1.00') });
        expect(failed.status).toBe(503);
        expect(failed.body).toMatchObject({
          code: 'TEMPORARILY_UNAVAILABLE',
          status: 503,
        });
        expect(failed.headers['retry-after']).toBe('1');

        const ready = await http().get('/health/ready').expect(503);
        expect(ready.body.checks.postgres.status).toBe('down');
        await http().get('/health/live').expect(200);

        await proxy.restore();

        await http().get('/health/ready').expect(200);
        await http()
          .post('/wallets')
          .send({ playerId: randomUUID(), initialBalance: money('1.00') })
          .expect(201);
      } finally {
        await proxy.close();
      }
    });
  });
});
