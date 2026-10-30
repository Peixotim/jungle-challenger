import { randomUUID } from 'node:crypto';
import {
  GetQueueAttributesCommand,
  Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { SQS_TEST_ENV } from '../../support/test-env.js';

export const QUEUES = {
  requests: SQS_TEST_ENV.SQS_QUEUE_URL,
  dlq: SQS_TEST_ENV.SQS_DLQ_URL,
  events: SQS_TEST_ENV.SQS_EVENTS_QUEUE_URL,
};

export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: SQS_TEST_ENV.AWS_REGION,
    endpoint: SQS_TEST_ENV.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export async function purgeAll(client: SQSClient): Promise<void> {
  for (const QueueUrl of Object.values(QUEUES)) {
    await client.send(new PurgeQueueCommand({ QueueUrl }));
  }
}

export async function setVisibilityTimeout(
  client: SQSClient,
  queueUrl: string,
  seconds: number,
): Promise<void> {
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: { VisibilityTimeout: String(seconds) },
    }),
  );
}

export async function sendMessage(
  client: SQSClient,
  queueUrl: string,
  body: unknown,
  groupId: string,
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

export async function drain(
  client: SQSClient,
  queueUrl: string,
  { waitSeconds = 1, maxRounds = 20 } = {},
): Promise<Message[]> {
  const all: Message[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) break;
    for (const message of messages) {
      all.push(message);
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }
  return all;
}

export async function queueDepth(
  client: SQSClient,
  queueUrl: string,
): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  { timeoutMs = 20_000, intervalMs = 150, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function wagerMessage(
  wallet: { id: string; playerId: string },
  over: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
) {
  const externalTransactionId =
    (data.externalTransactionId as string) ?? `ext-${randomUUID()}`;
  return {
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
    ...over,
  };
}
