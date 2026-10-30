import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthIndicator } from '../../../application/ports/HealthIndicator.js';
import { Logger } from '../../../application/ports/Logger.js';
import { LifecycleState } from '../../../infrastructure/lifecycle/LifecycleState.js';

export const HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

type CheckResult =
  | { status: 'up'; latencyMs: number }
  | { status: 'down'; latencyMs: number; reason: 'timeout' | 'unreachable' };

@Controller('health')
export class HealthController {
  constructor(
    @Inject(HEALTH_INDICATORS)
    private readonly indicators: readonly HealthIndicator[],
    @Inject(LifecycleState) private readonly lifecycle: LifecycleState,
    @Inject(Logger) private readonly logger: Logger,
  ) {}

  @Get('live')
  live() {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    if (this.lifecycle.isShuttingDown) {
      response.status(503);
      return { status: 'shutting_down', checks: {} };
    }

    const entries = await Promise.all(
      this.indicators.map(
        async (indicator) =>
          [indicator.name, await this.run(indicator)] as const,
      ),
    );
    const checks = Object.fromEntries(entries);
    const up = entries.every(([, result]) => result.status === 'up');
    response.status(up ? 200 : 503);
    return { status: up ? 'up' : 'down', checks };
  }

  private async run(indicator: HealthIndicator): Promise<CheckResult> {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        indicator.check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            HEALTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'timeout';
      this.logger.warn('health check failed', {
        check: indicator.name,
        reason: timedOut ? 'timeout' : 'unreachable',
        err: error,
      });
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        reason: timedOut ? 'timeout' : 'unreachable',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
