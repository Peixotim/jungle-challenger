import { Module } from '@nestjs/common';
import { Logger } from '../application/ports/Logger.js';
import { Metrics } from '../application/ports/Metrics.js';
import { APP_CONFIG } from '../config/app-config.js';
import type { AppConfig } from '../config/app-config.js';
import { LifecycleState } from '../infrastructure/lifecycle/LifecycleState.js';
import { JsonLogger } from '../infrastructure/observability/JsonLogger.js';
import { PrometheusMetrics } from '../infrastructure/observability/PrometheusMetrics.js';

@Module({
  providers: [
    {
      provide: JsonLogger,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new JsonLogger({
          level: config.log.level,
          service: config.serviceName,
        }),
    },
    { provide: Logger, useExisting: JsonLogger },
    { provide: PrometheusMetrics, useFactory: () => new PrometheusMetrics() },
    { provide: Metrics, useExisting: PrometheusMetrics },
    { provide: LifecycleState, useFactory: () => new LifecycleState() },
  ],
  exports: [JsonLogger, Logger, PrometheusMetrics, Metrics, LifecycleState],
})
export class ObservabilityModule {}
