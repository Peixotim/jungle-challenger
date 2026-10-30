import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../../application/ports/EventPublisher.js';
import { OutboxMessage } from '../../../domain/messaging/model/OutboxMessage.js';

export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    const payload = message.payload as {
      correlationId?: string;
      data?: { walletId?: string };
    };
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: payload.data?.walletId ?? message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
          eventId: { DataType: 'String', StringValue: message.id },
          ...(payload.correlationId
            ? {
                correlationId: {
                  DataType: 'String',
                  StringValue: payload.correlationId,
                },
              }
            : {}),
        },
      }),
    );
  }
}
