import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { HealthIndicator } from '../../../application/ports/HealthIndicator.js';

export class SqsHealthIndicator extends HealthIndicator {
  readonly name = 'sqs';

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrls: readonly string[],
  ) {
    super();
  }

  async check(): Promise<void> {
    await Promise.all(
      this.queueUrls.map((QueueUrl) =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    );
  }
}
