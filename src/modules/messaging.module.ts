import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { Clock } from '../application/ports/Clock.js';
import { EventPublisher } from '../application/ports/EventPublisher.js';
import { Logger } from '../application/ports/Logger.js';
import { Metrics } from '../application/ports/Metrics.js';
import { UnitOfWork } from '../application/ports/UnitOfWork.js';
import { MessageOutcomePolicy } from '../application/services/MessageOutcomePolicy.js';
import { PublishOutbox } from '../application/use-cases/PublishOutbox.js';
import { APP_CONFIG } from '../config/app-config.js';
import type { AppConfig } from '../config/app-config.js';
import {
  createSqsClient,
  SQS_CLIENT,
} from '../infrastructure/messaging/sqs/sqs-client.js';
import { SqsEventPublisher } from '../infrastructure/messaging/sqs/SqsEventPublisher.js';
import { SqsHealthIndicator } from '../infrastructure/messaging/sqs/SqsHealthIndicator.js';
import { SqsConsumerRunner } from '../interface/sqs/SqsConsumerRunner.js';
import { WagerMessageHandler } from '../interface/sqs/WagerMessageHandler.js';
import { WorkerRunner } from '../interface/workers/WorkerRunner.js';
import { ApplicationModule } from './application.module.js';
import { ObservabilityModule } from './observability.module.js';
import { PersistenceModule } from './persistence.module.js';

@Module({
  imports: [ApplicationModule, ObservabilityModule, PersistenceModule],
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.sqs),
    },
    {
      provide: EventPublisher,
      inject: [SQS_CLIENT, APP_CONFIG],
      useFactory: (client: SQSClient, config: AppConfig) =>
        new SqsEventPublisher(client, config.sqs.eventsQueueUrl),
    },
    {
      provide: SqsHealthIndicator,
      inject: [SQS_CLIENT, APP_CONFIG],
      useFactory: (client: SQSClient, config: AppConfig) =>
        new SqsHealthIndicator(client, [
          config.sqs.queueUrl,
          config.sqs.eventsQueueUrl,
        ]),
    },
    {
      provide: PublishOutbox,
      inject: [UnitOfWork, EventPublisher, Clock, Metrics, Logger, APP_CONFIG],
      useFactory: (
        uow: UnitOfWork,
        publisher: EventPublisher,
        clock: Clock,
        metrics: Metrics,
        logger: Logger,
        config: AppConfig,
      ) =>
        new PublishOutbox(
          uow,
          publisher,
          clock,
          metrics,
          logger,
          config.workers.outbox.batchSize,
        ),
    },
    {
      provide: MessageOutcomePolicy,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new MessageOutcomePolicy({
          maxAttempts: config.sqs.consumer.maxAttempts,
          retryBaseSeconds: config.sqs.consumer.retryBaseSeconds,
          retryMaxSeconds: config.sqs.consumer.retryMaxSeconds,
        }),
    },
    WagerMessageHandler,
    SqsConsumerRunner,
    WorkerRunner,
  ],
  exports: [SqsHealthIndicator],
})
export class MessagingModule {}
