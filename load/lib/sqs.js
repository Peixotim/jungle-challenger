import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { PROVIDER_ID, SQS } from './config.js';
import { externalId, money } from './api.js';

// Talks to SQS through its JSON protocol, unsigned: LocalStack does not verify signatures.
function call(action, payload) {
  const response = http.post(`${SQS.endpoint}/`, JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': `AmazonSQS.${action}`,
    },
    tags: { sqs: action },
  });
  if (response.status !== 200) {
    exec.test.abort(`SQS ${action} failed: ${response.status} ${response.body}`);
  }
  return response.json();
}

export function wagerEnvelope(wallet, over = {}) {
  const { data = {}, ...envelope } = over;
  const externalTransactionId = externalId();
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-load',
      gameId: 'game-load',
      kind: 'BET',
      money: money('1.00'),
      ...data,
    },
    ...envelope,
  };
}

// The FIFO queue has content-based deduplication, so every send carries its own
// deduplication id: duplicates must reach the application, not die in SQS.
export function sendWager(envelope, opts = {}) {
  const { groupId = envelope.data.walletId, dedupId = crypto.randomUUID() } = opts;
  call('SendMessage', {
    QueueUrl: SQS.queueUrl,
    MessageBody: JSON.stringify(envelope),
    MessageGroupId: groupId,
    MessageDeduplicationId: dedupId,
  });
}

export function queueCounts(queueUrl) {
  const { Attributes } = call('GetQueueAttributes', {
    QueueUrl: queueUrl,
    AttributeNames: [
      'ApproximateNumberOfMessages',
      'ApproximateNumberOfMessagesNotVisible',
      'ApproximateNumberOfMessagesDelayed',
    ],
  });
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible),
    delayed: Number(Attributes.ApproximateNumberOfMessagesDelayed),
  };
}

export function purgeQueue(queueUrl) {
  call('PurgeQueue', { QueueUrl: queueUrl });
}

const total = (counts) => counts.visible + counts.inFlight + counts.delayed;

export function assertQueuesEmpty() {
  for (const queueUrl of [SQS.queueUrl, SQS.dlqUrl]) {
    if (total(queueCounts(queueUrl)) > 0) {
      exec.test.abort(
        `queue not empty: ${queueUrl}. Purge it first: docker exec jungle-localstack awslocal sqs purge-queue --queue-url ${queueUrl}`,
      );
    }
  }
}

// Seconds until the main queue has no visible, in-flight or delayed messages; null on timeout.
export function waitDrained(timeoutMs = 300000, pollMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (total(queueCounts(SQS.queueUrl)) === 0) {
      return (Date.now() - startedAt) / 1000;
    }
    sleep(pollMs / 1000);
  }
  return null;
}
