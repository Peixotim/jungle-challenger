import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { CreateWallet } from '../src/application/use-cases/CreateWallet.js';
import { GetWallet } from '../src/application/use-cases/GetWallet.js';
import { GetWalletLedger } from '../src/application/use-cases/GetWalletLedger.js';
import { ReconcileWallet } from '../src/application/use-cases/ReconcileWallet.js';
import { SubmitWagerTransaction } from '../src/application/use-cases/SubmitWagerTransaction.js';
import { configureApp } from '../src/bootstrap/configure-app.js';
import { APP_CONFIG } from '../src/config/app-config.js';
import type { AppConfig } from '../src/config/app-config.js';
import { ConfigError } from '../src/config/env.js';
import { LifecycleState } from '../src/infrastructure/lifecycle/LifecycleState.js';
import { JsonLogger } from '../src/infrastructure/observability/JsonLogger.js';
import { PrometheusMetrics } from '../src/infrastructure/observability/PrometheusMetrics.js';
import {
  connectTestDatabase,
  TestDatabase,
  testDatabaseUrl,
} from './integration/support/database.js';
import { applicationTestEnv } from './support/test-env.js';

describe('application bootstrap (e2e)', () => {
  const originalEnv = { ...process.env };
  let db: TestDatabase;
  let app: NestExpressApplication | undefined;

  beforeAll(async () => {
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    process.env = { ...originalEnv, ...applicationTestEnv(testDatabaseUrl()) };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = { ...originalEnv };
  });

  async function start(): Promise<NestExpressApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const instance = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(
      instance,
      instance.get<AppConfig>(APP_CONFIG),
      instance.get(JsonLogger),
      instance.get(PrometheusMetrics),
    );
    await instance.init();
    app = instance;
    return instance;
  }

  it('boots against a migrated database and answers with problem+json', async () => {
    const instance = await start();

    const response = await request(instance.getHttpServer())
      .get('/does-not-exist')
      .expect(404);

    expect(response.headers['content-type']).toMatch(/problem\+json/);
    expect(response.headers['x-correlation-id']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('wires the use cases through the real adapters end to end', async () => {
    const instance = await start();
    const playerId = randomUUID();

    const wallet = await instance.get(CreateWallet).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'e2e-1',
    });
    const bet = await instance.get(SubmitWagerTransaction).execute({
      idempotencyKey: 'provider-a:e2e-bet',
      providerId: 'provider-a',
      externalTransactionId: 'e2e-bet',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET' as never,
      money: { amount: '30.00', currency: 'BRL' },
      correlationId: 'e2e-2',
    });

    expect(bet).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '70.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(
      (await instance.get(GetWallet).execute(wallet.id)).balance.amount,
    ).toBe('70.00');
    expect(
      (await instance.get(GetWalletLedger).execute(wallet.id)).entries,
    ).toHaveLength(2);

    const reconciliation = await instance
      .get(ReconcileWallet)
      .execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(instance.get(PrometheusMetrics).render()).toContain(
      'wallet_reconciliations_total{result="consistent"} 1',
    );
  });

  it('refuses to start when the database schema is behind the code', async () => {
    await db.orm.migrator.down({ to: 0 });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const instance = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    app = instance;

    await expect(instance.init()).rejects.toThrow(
      /database schema is not up to date; pending migrations: Migration20260101000001CreateSchema, Migration20260101000002IntegrityTriggers/,
    );
  });

  it('can skip the migration check explicitly', async () => {
    await db.orm.migrator.down({ to: 0 });
    process.env.DATABASE_REQUIRE_MIGRATED = 'false';

    const instance = await start();

    expect(instance).toBeDefined();
  });

  it('fails fast on invalid configuration, naming every problem', async () => {
    process.env.DATABASE_URL = '';
    process.env.PORT = 'abc';

    const attempt = Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toThrow(/DATABASE_URL is required/);
    await expect(attempt).rejects.toThrow(/PORT must be an integer/);
  });

  it('releases the database pool on shutdown', async () => {
    const instance = await start();
    const orm = instance.get(MikroORM);
    expect(await orm.isConnected()).toBe(true);

    await instance.close();
    app = undefined;

    expect(await orm.isConnected()).toBe(false);
  });

  it('exposes the lifecycle flag used by readiness probes', async () => {
    const instance = await start();

    expect(instance.get(LifecycleState).isShuttingDown).toBe(false);
  });
});
