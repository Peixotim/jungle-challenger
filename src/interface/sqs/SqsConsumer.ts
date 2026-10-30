import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '../../application/ports/Logger.js';
import { Metrics } from '../../application/ports/Metrics.js';
import { MessageAction } from '../../application/services/MessageOutcomePolicy.js';
import { InboundMessage } from './WagerMessageHandler.js';

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  maxMessages: number;
  waitTimeSeconds: number;
}

export type MessageHandler = (
  message: InboundMessage,
) => Promise<MessageAction>;

const RECEIVE_ERROR_PAUSE_MS = 2_000;

export class SqsConsumer {
  private stopping = false;
  private loop?: Promise<void>;
  private wakePause?: () => void;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsConsumerOptions,
    private readonly handler: MessageHandler,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakePause?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[];
      try {
        messages = await this.receive();
      } catch (error) {
        if (this.stopping) break;
        this.metrics.increment('sqs_receive_errors_total');
        this.logger.error('sqs receive failed', { err: error });
        await this.pause(RECEIVE_ERROR_PAUSE_MS);
        continue;
      }
      await this.processBatch(messages);
    }
  }

  private async receive(): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
        MessageAttributeNames: ['All'],
      }),
    );
    return response.Messages ?? [];
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) await this.release(message);
          else await this.processOne(message);
        }
      }),
    );
  }

  private async processOne(message: Message): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? 1,
    );

    let action: MessageAction;
    try {
      action = await this.handler({ body: message.Body ?? '', receiveCount });
    } catch (error) {
      this.logger.error('wager message handler crashed', { err: error });
      action = { kind: 'retry', delaySeconds: 0 };
    }

    try {
      await this.apply(message, action, receiveCount);
    } catch (error) {
      this.logger.error(
        'sqs message disposition failed; it will be redelivered',
        {
          messageId: message.MessageId,
          action: action.kind,
          err: error,
        },
      );
    }
    this.metrics.observe(
      'sqs_message_processing_seconds',
      Number(process.hrtime.bigint() - startedAt) / 1e9,
    );
  }

  private async apply(
    message: Message,
    action: MessageAction,
    receiveCount: number,
  ): Promise<void> {
    switch (action.kind) {
      case 'ack':
        await this.delete(message);
        this.metrics.increment('sqs_messages_total', { outcome: 'processed' });
        return;
      case 'retry':
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.options.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: action.delaySeconds,
          }),
        );
        this.metrics.increment('sqs_messages_total', { outcome: 'retry' });
        this.metrics.increment('sqs_retries_total');
        return;
      case 'dead-letter':
        await this.deadLetter(message, action.reason, receiveCount);
        return;
    }
  }

  private async deadLetter(
    message: Message,
    reason: string,
    receiveCount: number,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: reason },
          originalMessageId: {
            DataType: 'String',
            StringValue: message.MessageId ?? '',
          },
          receiveCount: {
            DataType: 'Number',
            StringValue: String(receiveCount),
          },
        },
      }),
    );
    await this.delete(message);
    this.metrics.increment('sqs_messages_total', { outcome: 'dead_letter' });
    this.metrics.increment('sqs_dlq_messages_total', { reason });
    this.logger.warn('wager message moved to dead-letter queue', {
      messageId: message.MessageId,
      reason,
      receiveCount,
    });
  }

  private delete(message: Message): Promise<unknown> {
    return this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async release(message: Message): Promise<void> {
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      this.metrics.increment('sqs_messages_total', { outcome: 'released' });
    } catch (error) {
      this.logger.warn('could not release message on shutdown', {
        messageId: message.MessageId,
        err: error,
      });
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakePause = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakePause = done;
    });
  }
}
