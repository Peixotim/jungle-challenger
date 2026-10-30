const LOCALSTACK_QUEUE_BASE =
  'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000';

export const SQS_TEST_ENV = {
  AWS_REGION: 'us-east-1',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_QUEUE_URL: `${LOCALSTACK_QUEUE_BASE}/wager-transactions.fifo`,
  SQS_DLQ_URL: `${LOCALSTACK_QUEUE_BASE}/wager-transactions-dlq.fifo`,
  SQS_EVENTS_QUEUE_URL: `${LOCALSTACK_QUEUE_BASE}/wager-events.fifo`,
};

export const BACKGROUND_OFF_ENV = {
  SQS_CONSUMER_ENABLED: 'false',
  WORKERS_ENABLED: 'false',
};

export function applicationTestEnv(
  databaseUrl: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl,
    ...SQS_TEST_ENV,
    ...BACKGROUND_OFF_ENV,
    ...overrides,
  };
}
