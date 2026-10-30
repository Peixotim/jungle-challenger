import { Clock } from '../ports/Clock.js';
import { Logger } from '../ports/Logger.js';
import { Metrics } from '../ports/Metrics.js';
import { UnitOfWork } from '../ports/UnitOfWork.js';
import { WagerTransactionProcessor } from '../services/WagerTransactionProcessor.js';

export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly processor: WagerTransactionProcessor,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(limit = 50): Promise<number> {
    let handled = 0;
    while (handled < limit) {
      const retried = await this.uow.run(async (ctx) => {
        const tx = await ctx.transactions.claimNextDueForReference(
          this.clock.now(),
        );
        if (!tx) return false;

        await this.processor.process(ctx, tx, { correlationId: tx.id });
        this.metrics.increment('wager_reference_retries_total', {
          outcome: tx.status,
        });
        this.logger.info('pending reference retried', {
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          status: tx.status,
          attempts: tx.referenceAttempts,
        });
        return true;
      });
      if (!retried) break;
      handled += 1;
    }
    return handled;
  }
}
