import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  BeforeApplicationShutdown,
  Inject,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Logger } from '../../application/ports/Logger.js';
import { Metrics } from '../../application/ports/Metrics.js';
import { APP_CONFIG } from '../../config/app-config.js';
import type { AppConfig } from '../../config/app-config.js';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs/sqs-client.js';
import { SqsConsumer } from './SqsConsumer.js';
import { WagerMessageHandler } from './WagerMessageHandler.js';

export class SqsConsumerRunner
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private consumer?: SqsConsumer;

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WagerMessageHandler) private readonly handler: WagerMessageHandler,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(Logger) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const { sqs } = this.config;
    if (!sqs.consumer.enabled) {
      this.logger.info('sqs consumer disabled');
      return;
    }
    this.consumer = new SqsConsumer(
      this.client,
      {
        queueUrl: sqs.queueUrl,
        dlqUrl: sqs.dlqUrl,
        maxMessages: sqs.consumer.maxMessages,
        waitTimeSeconds: sqs.consumer.waitTimeSeconds,
      },
      (message) => this.handler.handle(message),
      this.metrics,
      this.logger,
    );
    this.consumer.start();
    this.logger.info('sqs consumer started', { queueUrl: sqs.queueUrl });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
    this.consumer = undefined;
  }
}
