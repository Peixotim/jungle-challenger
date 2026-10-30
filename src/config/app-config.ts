import { ConfigError, Env, EnvReader } from './env.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface AppConfig {
  env: Environment;
  serviceName: string;
  log: { level: LogLevel };
  http: {
    host: string;
    port: number;
    bodyLimit: string;
    trustProxy: boolean | number;
    docsEnabled: boolean;
    keepAliveTimeoutMs: number;
    headersTimeoutMs: number;
    requestTimeoutMs: number;
  };
  shutdownTimeoutMs: number;
  database: {
    url: string;
    poolMin: number;
    poolMax: number;
    requireMigrated: boolean;
  };
  processing: { maxReferenceAttempts: number };
  sqs: {
    region: string;
    endpoint?: string;
    queueUrl: string;
    dlqUrl: string;
    eventsQueueUrl: string;
    consumer: {
      enabled: boolean;
      maxMessages: number;
      waitTimeSeconds: number;
      maxAttempts: number;
      retryBaseSeconds: number;
      retryMaxSeconds: number;
    };
  };
  workers: {
    enabled: boolean;
    outbox: { intervalMs: number; batchSize: number };
    pendingReference: { intervalMs: number; batchSize: number };
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const reader = new EnvReader(env);

  const environment = reader.oneOf('NODE_ENV', ENVIRONMENTS, 'development');
  const config: AppConfig = {
    env: environment,
    serviceName: reader.string('SERVICE_NAME', 'wagering-processor'),
    log: {
      level: reader.oneOf(
        'LOG_LEVEL',
        LOG_LEVELS,
        environment === 'test' ? 'error' : 'info',
      ),
    },
    http: {
      host: reader.string('HOST', '0.0.0.0'),
      port: reader.integer('PORT', { default: 8080, min: 0, max: 65535 }),
      bodyLimit: reader.pattern(
        'HTTP_BODY_LIMIT',
        /^\d+(b|kb|mb)$/i,
        '100kb',
        'must look like 100kb, 1mb or 512b',
      ),
      trustProxy: reader.trustProxy('HTTP_TRUST_PROXY'),
      docsEnabled: reader.boolean('DOCS_ENABLED', environment !== 'production'),
      keepAliveTimeoutMs: reader.integer('HTTP_KEEP_ALIVE_TIMEOUT_MS', {
        default: 65_000,
        min: 1_000,
      }),
      headersTimeoutMs: reader.integer('HTTP_HEADERS_TIMEOUT_MS', {
        default: 66_000,
        min: 1_000,
      }),
      requestTimeoutMs: reader.integer('HTTP_REQUEST_TIMEOUT_MS', {
        default: 30_000,
        min: 1_000,
      }),
    },
    shutdownTimeoutMs: reader.integer('SHUTDOWN_TIMEOUT_MS', {
      default: 30_000,
      min: 1_000,
    }),
    database: {
      url: reader.requiredUrl('DATABASE_URL', ['postgres:', 'postgresql:']),
      poolMin: reader.integer('DATABASE_POOL_MIN', { default: 2, min: 0 }),
      poolMax: reader.integer('DATABASE_POOL_MAX', { default: 20, min: 1 }),
      requireMigrated: reader.boolean('DATABASE_REQUIRE_MIGRATED', true),
    },
    processing: {
      maxReferenceAttempts: reader.integer('PENDING_REFERENCE_MAX_ATTEMPTS', {
        default: 10,
        min: 1,
        max: 100,
      }),
    },
    sqs: {
      region: reader.string('AWS_REGION', 'us-east-1'),
      endpoint: reader.optionalUrl('AWS_ENDPOINT_URL', ['http:', 'https:']),
      queueUrl: reader.requiredUrl('SQS_QUEUE_URL', ['http:', 'https:']),
      dlqUrl: reader.requiredUrl('SQS_DLQ_URL', ['http:', 'https:']),
      eventsQueueUrl: reader.requiredUrl('SQS_EVENTS_QUEUE_URL', [
        'http:',
        'https:',
      ]),
      consumer: {
        enabled: reader.boolean('SQS_CONSUMER_ENABLED', true),
        maxMessages: reader.integer('SQS_MAX_MESSAGES', {
          default: 10,
          min: 1,
          max: 10,
        }),
        waitTimeSeconds: reader.integer('SQS_WAIT_TIME_SECONDS', {
          default: 20,
          min: 0,
          max: 20,
        }),
        maxAttempts: reader.integer('SQS_MAX_ATTEMPTS', {
          default: 5,
          min: 1,
          max: 20,
        }),
        retryBaseSeconds: reader.integer('SQS_RETRY_BASE_SECONDS', {
          default: 5,
          min: 0,
          max: 43_200,
        }),
        retryMaxSeconds: reader.integer('SQS_RETRY_MAX_SECONDS', {
          default: 300,
          min: 0,
          max: 43_200,
        }),
      },
    },
    workers: {
      enabled: reader.boolean('WORKERS_ENABLED', true),
      outbox: {
        intervalMs: reader.integer('OUTBOX_INTERVAL_MS', {
          default: 1_000,
          min: 50,
        }),
        batchSize: reader.integer('OUTBOX_BATCH_SIZE', {
          default: 50,
          min: 1,
          max: 500,
        }),
      },
      pendingReference: {
        intervalMs: reader.integer('PENDING_REFERENCE_INTERVAL_MS', {
          default: 5_000,
          min: 50,
        }),
        batchSize: reader.integer('PENDING_REFERENCE_BATCH_SIZE', {
          default: 50,
          min: 1,
          max: 500,
        }),
      },
    },
  };

  const { http, database, sqs } = config;
  if (sqs.consumer.retryBaseSeconds > sqs.consumer.retryMaxSeconds) {
    reader.problems.push(
      'SQS_RETRY_BASE_SECONDS must not exceed SQS_RETRY_MAX_SECONDS',
    );
  }
  if (database.poolMin > database.poolMax) {
    reader.problems.push('DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX');
  }
  if (http.headersTimeoutMs <= http.keepAliveTimeoutMs) {
    reader.problems.push(
      'HTTP_HEADERS_TIMEOUT_MS must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS',
    );
  }

  if (reader.problems.length > 0) throw new ConfigError(reader.problems);
  return config;
}

export function describeConfig(config: AppConfig): Record<string, unknown> {
  const database = new URL(config.database.url);
  if (database.password) database.password = '***';
  return {
    env: config.env,
    http: {
      host: config.http.host,
      port: config.http.port,
      trustProxy: config.http.trustProxy,
      docsEnabled: config.http.docsEnabled,
    },
    database: {
      url: database.toString(),
      poolMin: config.database.poolMin,
      poolMax: config.database.poolMax,
      requireMigrated: config.database.requireMigrated,
    },
    sqs: {
      region: config.sqs.region,
      endpoint: config.sqs.endpoint,
      queueUrl: config.sqs.queueUrl,
      consumerEnabled: config.sqs.consumer.enabled,
    },
    workersEnabled: config.workers.enabled,
    logLevel: config.log.level,
    maxReferenceAttempts: config.processing.maxReferenceAttempts,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
}
