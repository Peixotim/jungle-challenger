import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HealthIndicator } from '../application/ports/HealthIndicator.js';
import { DatabaseHealthIndicator } from '../infrastructure/persistence/DatabaseHealthIndicator.js';
import { AuthGuard, NoopAuthGuard } from '../interface/http/auth/AuthGuard.js';
import {
  HEALTH_INDICATORS,
  HealthController,
} from '../interface/http/controllers/HealthController.js';
import { MetricsController } from '../interface/http/controllers/MetricsController.js';
import { WageringController } from '../interface/http/controllers/WageringController.js';
import { WalletsController } from '../interface/http/controllers/WalletsController.js';
import { AllExceptionsFilter } from '../interface/http/filters/AllExceptionsFilter.js';
import { ApplicationModule } from './application.module.js';
import { ObservabilityModule } from './observability.module.js';
import { PersistenceModule } from './persistence.module.js';

@Module({
  imports: [ApplicationModule, ObservabilityModule, PersistenceModule],
  controllers: [
    WalletsController,
    WageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: AuthGuard, useClass: NoopAuthGuard },
    { provide: APP_GUARD, useExisting: AuthGuard },
    {
      provide: HEALTH_INDICATORS,
      inject: [DatabaseHealthIndicator],
      useFactory: (...indicators: HealthIndicator[]) => indicators,
    },
  ],
})
export class HttpModule {}
