import { InboxMessage } from '../../domain/messaging/model/InboxMessage.js';
import { Money } from '../../domain/money/model/Money.js';
import { WagerTransaction } from '../../domain/wagering/model/WagerTransaction.js';
import { SubmitWagerTransactionCommand } from '../dtos/SubmitWagerTransactionCommand.js';
import { SubmitWagerTransactionResult } from '../dtos/SubmitWagerTransactionResult.js';
import { IdempotencyConflictError } from '../errors/application-errors.js';
import { computePayloadHash } from '../idempotency/payload-hash.js';
import { toSubmitResult } from '../mappers/views.js';
import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { Metrics } from '../ports/Metrics.js';
import { TransactionalContext, UnitOfWork } from '../ports/UnitOfWork.js';
import { WagerTransactionProcessor } from '../services/WagerTransactionProcessor.js';

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly processor: WagerTransactionProcessor,
    private readonly metrics: Metrics,
  ) {}

  async execute(
    cmd: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    const startedAt = this.clock.now();
    const money = Money.from(cmd.money);
    const candidate = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: computePayloadHash({ ...cmd, money }),
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });

    const result = await this.uow.run(async (ctx) => {
      const inbox = cmd.source
        ? await this.receive(ctx, cmd.source, candidate.payloadHash)
        : undefined;

      const outcome = await this.submit(ctx, candidate, cmd);

      if (inbox) {
        inbox.markProcessed(this.clock.now());
        await ctx.inbox.markProcessed(inbox);
      }
      return outcome;
    });

    this.record(candidate.kind, result, startedAt);
    return result;
  }

  private record(
    kind: string,
    result: SubmitWagerTransactionResult,
    startedAt: Date,
  ): void {
    if (result.idempotentReplay) {
      this.metrics.increment('wager_duplicates_total', { kind });
    } else {
      this.metrics.increment('wager_transactions_total', {
        kind,
        status: result.status,
      });
    }
    this.metrics.observe(
      'wager_processing_seconds',
      (this.clock.now().getTime() - startedAt.getTime()) / 1000,
      { kind },
    );
  }

  private async receive(
    ctx: TransactionalContext,
    source: { consumerName: string; messageId: string },
    payloadHash: string,
  ): Promise<InboxMessage | undefined> {
    const message = InboxMessage.receive({
      ...source,
      payloadHash,
      receivedAt: this.clock.now(),
    });
    return (await ctx.inbox.receiveIfAbsent(message)) ? message : undefined;
  }

  private async submit(
    ctx: TransactionalContext,
    candidate: WagerTransaction,
    cmd: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    const { transaction: stored, inserted } =
      await ctx.transactions.insertIfAbsent(candidate);
    if (!inserted) return this.replay(stored, candidate);

    await this.processor.process(ctx, candidate, {
      correlationId: cmd.correlationId,
      causationId: cmd.source?.messageId,
    });
    return toSubmitResult(candidate, false);
  }

  private replay(
    stored: WagerTransaction,
    candidate: WagerTransaction,
  ): SubmitWagerTransactionResult {
    if (stored.idempotencyKey !== candidate.idempotencyKey) {
      this.metrics.increment('wager_idempotency_conflicts_total', {
        reason: 'EXTERNAL_ID_REUSED',
      });
      throw new IdempotencyConflictError(
        'EXTERNAL_ID_REUSED',
        candidate.idempotencyKey,
      );
    }
    if (!stored.matchesPayload(candidate.payloadHash)) {
      this.metrics.increment('wager_idempotency_conflicts_total', {
        reason: 'PAYLOAD_MISMATCH',
      });
      throw new IdempotencyConflictError(
        'PAYLOAD_MISMATCH',
        candidate.idempotencyKey,
      );
    }
    return toSubmitResult(stored, true);
  }
}
