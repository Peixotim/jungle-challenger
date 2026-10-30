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
import { TransactionalContext, UnitOfWork } from '../ports/UnitOfWork.js';
import { WagerTransactionProcessor } from '../services/WagerTransactionProcessor.js';

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly processor: WagerTransactionProcessor,
  ) {}

  async execute(
    cmd: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
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

    return this.uow.run(async (ctx) => {
      const inbox = cmd.source
        ? await this.receive(ctx, cmd.source, candidate.payloadHash)
        : undefined;

      const result = await this.submit(ctx, candidate, cmd);

      if (inbox) {
        inbox.markProcessed(this.clock.now());
        await ctx.inbox.markProcessed(inbox);
      }
      return result;
    });
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
      throw new IdempotencyConflictError(
        'EXTERNAL_ID_REUSED',
        candidate.idempotencyKey,
      );
    }
    if (!stored.matchesPayload(candidate.payloadHash)) {
      throw new IdempotencyConflictError(
        'PAYLOAD_MISMATCH',
        candidate.idempotencyKey,
      );
    }
    return toSubmitResult(stored, true);
  }
}
