import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../../config/app-config.js';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(config: AppConfig['sqs']): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    maxAttempts: 3,
  });
}
