import { Logger } from '../../application/ports/Logger.js';
import { Metrics } from '../../application/ports/Metrics.js';

export class PeriodicTask {
  private stopped = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly run: () => Promise<boolean>,
    private readonly intervalMs: number,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.loop) return;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let moreWork = false;
      try {
        moreWork = await this.run();
        this.metrics.increment('worker_ticks_total', { task: this.name });
      } catch (error) {
        this.metrics.increment('worker_failures_total', { task: this.name });
        this.logger.error('worker tick failed', {
          task: this.name,
          err: error,
        });
      }
      if (this.stopped) return;
      if (!moreWork) await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.intervalMs);
      this.wake = done;
    });
  }
}
