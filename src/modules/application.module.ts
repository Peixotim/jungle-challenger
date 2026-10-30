import { Module } from '@nestjs/common';
import { Clock } from '../application/ports/Clock.js';
import { IdGenerator } from '../application/ports/IdGenerator.js';
import { Logger } from '../application/ports/Logger.js';
import { Metrics } from '../application/ports/Metrics.js';
import { UnitOfWork } from '../application/ports/UnitOfWork.js';
import { WagerTransactionProcessor } from '../application/services/WagerTransactionProcessor.js';
import { CreateWallet } from '../application/use-cases/CreateWallet.js';
import { GetWagerTransaction } from '../application/use-cases/GetWagerTransaction.js';
import { GetWallet } from '../application/use-cases/GetWallet.js';
import { GetWalletLedger } from '../application/use-cases/GetWalletLedger.js';
import { ReconcileWallet } from '../application/use-cases/ReconcileWallet.js';
import { ReprocessPendingReferences } from '../application/use-cases/ReprocessPendingReferences.js';
import { SubmitWagerTransaction } from '../application/use-cases/SubmitWagerTransaction.js';
import { APP_CONFIG } from '../config/app-config.js';
import type { AppConfig } from '../config/app-config.js';
import { SystemClock } from '../infrastructure/system/SystemClock.js';
import { UuidV7Generator } from '../infrastructure/system/UuidV7Generator.js';
import { ObservabilityModule } from './observability.module.js';
import { PersistenceModule } from './persistence.module.js';

const USE_CASES = [
  SubmitWagerTransaction,
  CreateWallet,
  ReprocessPendingReferences,
  ReconcileWallet,
  GetWallet,
  GetWalletLedger,
  GetWagerTransaction,
];

@Module({
  imports: [PersistenceModule, ObservabilityModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
    {
      provide: WagerTransactionProcessor,
      inject: [Clock, IdGenerator, APP_CONFIG],
      useFactory: (clock: Clock, ids: IdGenerator, config: AppConfig) =>
        new WagerTransactionProcessor(
          clock,
          ids,
          config.processing.maxReferenceAttempts,
        ),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UnitOfWork, Clock, IdGenerator, WagerTransactionProcessor],
      useFactory: (
        uow: UnitOfWork,
        clock: Clock,
        ids: IdGenerator,
        processor: WagerTransactionProcessor,
      ) => new SubmitWagerTransaction(uow, clock, ids, processor),
    },
    {
      provide: CreateWallet,
      inject: [UnitOfWork, Clock, IdGenerator],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWallet(uow, clock, ids),
    },
    {
      provide: ReprocessPendingReferences,
      inject: [UnitOfWork, Clock, WagerTransactionProcessor, Metrics, Logger],
      useFactory: (
        uow: UnitOfWork,
        clock: Clock,
        processor: WagerTransactionProcessor,
        metrics: Metrics,
        logger: Logger,
      ) =>
        new ReprocessPendingReferences(uow, clock, processor, metrics, logger),
    },
    {
      provide: ReconcileWallet,
      inject: [UnitOfWork, Metrics, Logger],
      useFactory: (uow: UnitOfWork, metrics: Metrics, logger: Logger) =>
        new ReconcileWallet(uow, metrics, logger),
    },
    {
      provide: GetWallet,
      inject: [UnitOfWork],
      useFactory: (uow: UnitOfWork) => new GetWallet(uow),
    },
    {
      provide: GetWalletLedger,
      inject: [UnitOfWork],
      useFactory: (uow: UnitOfWork) => new GetWalletLedger(uow),
    },
    {
      provide: GetWagerTransaction,
      inject: [UnitOfWork],
      useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow),
    },
  ],
  exports: [Clock, IdGenerator, WagerTransactionProcessor, ...USE_CASES],
})
export class ApplicationModule {}
