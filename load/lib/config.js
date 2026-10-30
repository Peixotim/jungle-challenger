export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
export const CURRENCY = 'BRL';
export const PROVIDER_ID = 'load-provider';

const queueBase =
  'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000';

export const SQS = {
  endpoint: __ENV.SQS_ENDPOINT || 'http://localhost:4566',
  region: __ENV.AWS_REGION || 'us-east-1',
  accessKeyId: __ENV.AWS_ACCESS_KEY_ID || 'test',
  secretAccessKey: __ENV.AWS_SECRET_ACCESS_KEY || 'test',
  queueUrl: __ENV.SQS_QUEUE_URL || `${queueBase}/wager-transactions.fifo`,
  dlqUrl: __ENV.SQS_DLQ_URL || `${queueBase}/wager-transactions-dlq.fifo`,
};
