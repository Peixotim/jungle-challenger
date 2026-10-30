import { Clock } from '../ports/Clock.js';
import { EventPublisher } from '../ports/EventPublisher.js';
import { Logger } from '../ports/Logger.js';
import { Metrics } from '../ports/Metrics.js';
import { UnitOfWork } from '../ports/UnitOfWork.js';

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly batchSize = 50,
  ) {}

  async execute(): Promise<PublishOutboxResult> {
    return this.uow.run(async (ctx) => {
      const claimedAt = this.clock.now();
      const batch = await ctx.outbox.claimDue(claimedAt, this.batchSize);
      const result: PublishOutboxResult = { published: 0, failed: 0 };

      for (const message of batch) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          result.published += 1;
          this.metrics.observe(
            'outbox_lag_seconds',
            (claimedAt.getTime() - message.occurredAt.getTime()) / 1000,
          );
        } catch (error) {
          message.scheduleRetry(this.clock.now());
          result.failed += 1;
          this.metrics.increment('outbox_publish_failures_total');
          this.logger.warn('outbox publish failed', {
            messageId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            reason: error instanceof Error ? error.message : 'unknown',
          });
        }
        await ctx.outbox.save(message);
      }
      return result;
    });
  }
}
