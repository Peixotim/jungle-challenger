import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  MessageAction,
  MessageOutcomePolicy,
} from '../../../src/application/services/MessageOutcomePolicy.js';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/SubmitWagerTransaction.js';
import { SqsConsumer } from '../../../src/interface/sqs/SqsConsumer.js';
import {
  InboundMessage,
  WagerMessageHandler,
} from '../../../src/interface/sqs/WagerMessageHandler.js';
import { App } from './app.js';
import { QUEUES } from './sqs.js';

export interface ConsumerOptions {
  submit?: SubmitWagerTransaction;
  maxAttempts?: number;
  retryBaseSeconds?: number;
  waitTimeSeconds?: number;
  handlerDelayMs?: number;
}

export function buildConsumer(
  app: App,
  client: Pick<SQSClient, 'send'>,
  options: ConsumerOptions = {},
): SqsConsumer {
  const policy = new MessageOutcomePolicy({
    maxAttempts: options.maxAttempts ?? 5,
    retryBaseSeconds: options.retryBaseSeconds ?? 0,
    retryMaxSeconds: 1,
  });
  const handler = new WagerMessageHandler(
    options.submit ?? app.submit,
    policy,
    app.metrics,
    app.logger,
  );
  const handle = async (message: InboundMessage): Promise<MessageAction> => {
    if (options.handlerDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.handlerDelayMs),
      );
    }
    return handler.handle(message);
  };
  return new SqsConsumer(
    client as SQSClient,
    {
      queueUrl: QUEUES.requests,
      dlqUrl: QUEUES.dlq,
      maxMessages: 10,
      waitTimeSeconds: options.waitTimeSeconds ?? 1,
    },
    handle,
    app.metrics,
    app.logger,
  );
}
