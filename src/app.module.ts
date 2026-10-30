import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './config/config.module.js';
import { AllExceptionsFilter } from './interface/http/filters/AllExceptionsFilter.js';
import { ApplicationModule } from './modules/application.module.js';
import { ObservabilityModule } from './modules/observability.module.js';
import { PersistenceModule } from './modules/persistence.module.js';

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    PersistenceModule,
    ApplicationModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
