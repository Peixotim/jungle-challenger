import { WagerTransactionProcessor } from '../../../src/application/services/WagerTransactionProcessor.js';
import { SubmitWagerTransactionCommand } from '../../../src/application/dtos/SubmitWagerTransactionCommand.js';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/enums/WagerTransactionKind.js';
import {
  FakePublisher,
  FixedClock,
  InMemoryDatabase,
  RecordingLogger,
  RecordingMetrics,
  SequentialIds,
} from './InMemoryDatabase.js';

export const money = (amount: string) => ({ amount, currency: 'BRL' });

export const command = (
  over: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand => ({
  idempotencyKey: 'provider-a:tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'r1',
  gameId: 'g1',
  kind: Kind.Bet,
  money: money('25.00'),
  correlationId: 'corr-1',
  ...over,
});

export const next = (
  externalTransactionId: string,
  over: Partial<SubmitWagerTransactionCommand> = {},
) =>
  command({
    idempotencyKey: `provider-a:${externalTransactionId}`,
    externalTransactionId,
    ...over,
  });

export function harness(
  opts: { balance?: string; maxReferenceAttempts?: number } = {},
) {
  const db = new InMemoryDatabase();
  if (opts.balance !== undefined) db.seedWallet(opts.balance);
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();
  const publisher = new FakePublisher();
  const processor = new WagerTransactionProcessor(
    clock,
    ids,
    opts.maxReferenceAttempts,
  );
  return { db, clock, ids, metrics, logger, publisher, processor };
}
