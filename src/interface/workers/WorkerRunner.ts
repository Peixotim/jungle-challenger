import {
  BeforeApplicationShutdown,
  Inject,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Logger } from '../../application/ports/Logger.js';
import { Metrics } from '../../application/ports/Metrics.js';
import { PublishOutbox } from '../../application/use-cases/PublishOutbox.js';
import { ReprocessPendingReferences } from '../../application/use-cases/ReprocessPendingReferences.js';
import { APP_CONFIG } from '../../config/app-config.js';
import type { AppConfig } from '../../config/app-config.js';
import { PeriodicTask } from './PeriodicTask.js';

export class WorkerRunner
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private tasks: PeriodicTask[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutbox) private readonly publishOutbox: PublishOutbox,
    @Inject(ReprocessPendingReferences)
    private readonly reprocess: ReprocessPendingReferences,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(Logger) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const { workers } = this.config;
    if (!workers.enabled) {
      this.logger.info('background workers disabled');
      return;
    }

    this.tasks = [
      new PeriodicTask(
        'outbox-publisher',
        async () => {
          const { published, failed } = await this.publishOutbox.execute();
          return published + failed >= workers.outbox.batchSize;
        },
        workers.outbox.intervalMs,
        this.logger,
        this.metrics,
      ),
      new PeriodicTask(
        'pending-reference',
        async () =>
          (await this.reprocess.execute(workers.pendingReference.batchSize)) >=
          workers.pendingReference.batchSize,
        workers.pendingReference.intervalMs,
        this.logger,
        this.metrics,
      ),
    ];
    for (const task of this.tasks) task.start();
    this.logger.info('background workers started', {
      count: this.tasks.length,
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.tasks.map((task) => task.stop()));
    this.tasks = [];
  }
}
