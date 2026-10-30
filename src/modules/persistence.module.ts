import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { Metrics } from '../application/ports/Metrics.js';
import { UnitOfWork } from '../application/ports/UnitOfWork.js';
import { APP_CONFIG } from '../config/app-config.js';
import type { AppConfig } from '../config/app-config.js';
import { DatabaseHealthIndicator } from '../infrastructure/persistence/DatabaseHealthIndicator.js';
import { DatabaseStartupCheck } from '../infrastructure/persistence/DatabaseStartupCheck.js';
import { createOrmConfig } from '../infrastructure/persistence/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../infrastructure/persistence/MikroOrmUnitOfWork.js';
import { ObservabilityModule } from './observability.module.js';

@Module({
  imports: [
    ObservabilityModule,
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...createOrmConfig(config.database.url, {
          min: config.database.poolMin,
          max: config.database.poolMax,
        }),
        registerRequestContext: false,
      }),
    }),
  ],
  providers: [
    {
      provide: UnitOfWork,
      inject: [MikroORM, Metrics],
      useFactory: (orm: MikroORM, metrics: Metrics) =>
        new MikroOrmUnitOfWork(orm.em as unknown as EntityManager, metrics),
    },
    DatabaseStartupCheck,
    DatabaseHealthIndicator,
  ],
  exports: [UnitOfWork, DatabaseHealthIndicator],
})
export class PersistenceModule {}
