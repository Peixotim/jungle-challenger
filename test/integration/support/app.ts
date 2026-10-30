import { randomUUID } from 'node:crypto';
import { SubmitWagerTransactionCommand } from '../../../src/application/dtos/SubmitWagerTransactionCommand.js';
import { WagerTransactionProcessor } from '../../../src/application/services/WagerTransactionProcessor.js';
import { CreateWallet } from '../../../src/application/use-cases/CreateWallet.js';
import { GetWagerTransaction } from '../../../src/application/use-cases/GetWagerTransaction.js';
import { GetWallet } from '../../../src/application/use-cases/GetWallet.js';
import { GetWalletLedger } from '../../../src/application/use-cases/GetWalletLedger.js';
import { PublishOutbox } from '../../../src/application/use-cases/PublishOutbox.js';
import { ReconcileWallet } from '../../../src/application/use-cases/ReconcileWallet.js';
import { ReprocessPendingReferences } from '../../../src/application/use-cases/ReprocessPendingReferences.js';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/SubmitWagerTransaction.js';
import { UuidV7Generator } from '../../../src/infrastructure/system/UuidV7Generator.js';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/enums/WagerTransactionKind.js';
import {
  FakePublisher,
  FixedClock,
  RecordingLogger,
  RecordingMetrics,
} from '../../application/fakes/InMemoryDatabase.js';
import { TestDatabase } from './database.js';

export const money = (amount: string) => ({ amount, currency: 'BRL' });

export function buildApp(db: TestDatabase, maxReferenceAttempts = 3) {
  const clock = new FixedClock(new Date());
  const ids = new UuidV7Generator();
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();
  const publisher = new FakePublisher();
  const processor = new WagerTransactionProcessor(
    clock,
    ids,
    maxReferenceAttempts,
  );
  const { uow } = db;
  return {
    db,
    clock,
    ids,
    metrics,
    logger,
    publisher,
    uow,
    createWallet: new CreateWallet(uow, clock, ids),
    submit: new SubmitWagerTransaction(uow, clock, ids, processor),
    reprocess: new ReprocessPendingReferences(
      uow,
      clock,
      processor,
      metrics,
      logger,
    ),
    publishOutbox: (batchSize?: number) =>
      new PublishOutbox(uow, publisher, clock, metrics, logger, batchSize),
    reconcile: new ReconcileWallet(uow, metrics, logger),
    getWallet: new GetWallet(uow),
    getLedger: new GetWalletLedger(uow),
    getTransaction: new GetWagerTransaction(uow),
  };
}

export type App = ReturnType<typeof buildApp>;

export interface OpenedWallet {
  id: string;
  playerId: string;
}

export async function openWallet(
  app: App,
  balance = '1000.00',
): Promise<OpenedWallet> {
  const playerId = randomUUID();
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: money(balance),
    correlationId: randomUUID(),
  });
  return { id: wallet.id, playerId };
}

export function operation(
  wallet: OpenedWallet,
  over: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId =
    over.externalTransactionId ?? `ext-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: money('25.00'),
    correlationId: randomUUID(),
    ...over,
  };
}

export async function walletBalance(
  app: App,
  wallet: OpenedWallet,
): Promise<string> {
  return (await app.getWallet.execute(wallet.id)).balance.amount;
}

export async function expectConsistent(
  app: App,
  wallet: OpenedWallet,
): Promise<void> {
  const result = await app.reconcile.execute(wallet.id);
  expect(result.consistent).toBe(true);
  expect(result.difference.amount).toBe('0.00');
}
