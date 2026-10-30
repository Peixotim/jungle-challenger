import { describeConfig, loadConfig } from '../../src/config/app-config.js';
import { ConfigError } from '../../src/config/env.js';
import { SQS_TEST_ENV } from '../support/test-env.js';

const minimal = {
  DATABASE_URL: 'postgresql://jungle:s3cret@localhost:5432/jungle',
  ...SQS_TEST_ENV,
};

const problemsOf = (env: Record<string, string>): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).problems];
  }
  throw new Error('expected loadConfig to throw');
};

describe('loadConfig', () => {
  it('needs only DATABASE_URL and applies safe defaults', () => {
    const config = loadConfig(minimal);

    expect(config).toMatchObject({
      env: 'development',
      serviceName: 'wagering-processor',
      log: { level: 'info' },
      http: {
        host: '0.0.0.0',
        port: 8080,
        bodyLimit: '100kb',
        trustProxy: false,
        keepAliveTimeoutMs: 65_000,
        headersTimeoutMs: 66_000,
        requestTimeoutMs: 30_000,
      },
      shutdownTimeoutMs: 30_000,
      database: { poolMin: 2, poolMax: 20, requireMigrated: true },
      processing: { maxReferenceAttempts: 10 },
    });
  });

  it('reads every setting from the environment', () => {
    const config = loadConfig({
      ...minimal,
      NODE_ENV: 'production',
      SERVICE_NAME: 'wagering-a',
      LOG_LEVEL: 'warn',
      HOST: '127.0.0.1',
      PORT: '3000',
      HTTP_BODY_LIMIT: '2mb',
      HTTP_TRUST_PROXY: '2',
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '5000',
      HTTP_HEADERS_TIMEOUT_MS: '6000',
      HTTP_REQUEST_TIMEOUT_MS: '10000',
      SHUTDOWN_TIMEOUT_MS: '15000',
      DATABASE_POOL_MIN: '1',
      DATABASE_POOL_MAX: '5',
      DATABASE_REQUIRE_MIGRATED: 'false',
      PENDING_REFERENCE_MAX_ATTEMPTS: '4',
    });

    expect(config).toMatchObject({
      env: 'production',
      serviceName: 'wagering-a',
      log: { level: 'warn' },
      http: { host: '127.0.0.1', port: 3000, bodyLimit: '2mb', trustProxy: 2 },
      shutdownTimeoutMs: 15_000,
      database: { poolMin: 1, poolMax: 5, requireMigrated: false },
      processing: { maxReferenceAttempts: 4 },
    });
  });

  it('is quiet by default under test', () => {
    expect(loadConfig({ ...minimal, NODE_ENV: 'test' }).log.level).toBe(
      'error',
    );
  });

  it('treats blank values as unset', () => {
    expect(
      loadConfig({ ...minimal, PORT: '  ', LOG_LEVEL: '' }).http.port,
    ).toBe(8080);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = problemsOf({
      NODE_ENV: 'staging',
      PORT: 'eighty',
      LOG_LEVEL: 'verbose',
      HTTP_BODY_LIMIT: 'big',
      HTTP_TRUST_PROXY: 'maybe',
      DATABASE_POOL_MAX: '0',
      DATABASE_REQUIRE_MIGRATED: 'yes',
      PENDING_REFERENCE_MAX_ATTEMPTS: '1000',
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'NODE_ENV must be one of development, test, production',
        ),
        expect.stringContaining('PORT must be an integer'),
        expect.stringContaining('LOG_LEVEL must be one of'),
        expect.stringContaining('HTTP_BODY_LIMIT must look like'),
        expect.stringContaining('HTTP_TRUST_PROXY'),
        expect.stringContaining('DATABASE_URL is required'),
        expect.stringContaining('DATABASE_POOL_MAX must be >= 1'),
        expect.stringContaining(
          'DATABASE_REQUIRE_MIGRATED must be "true" or "false"',
        ),
        expect.stringContaining(
          'PENDING_REFERENCE_MAX_ATTEMPTS must be <= 100',
        ),
      ]),
    );
  });

  it('rejects a DATABASE_URL that is not PostgreSQL', () => {
    expect(
      problemsOf({ ...SQS_TEST_ENV, DATABASE_URL: 'mysql://localhost/db' }),
    ).toEqual([
      expect.stringContaining(
        'DATABASE_URL must use one of postgres:, postgresql:',
      ),
    ]);
    expect(problemsOf({ ...SQS_TEST_ENV, DATABASE_URL: 'not a url' })).toEqual([
      'DATABASE_URL is not a valid URL',
    ]);
  });

  it('rejects inconsistent combinations', () => {
    expect(
      problemsOf({
        ...minimal,
        DATABASE_POOL_MIN: '10',
        DATABASE_POOL_MAX: '5',
      }),
    ).toEqual(['DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX']);
    expect(
      problemsOf({
        ...minimal,
        HTTP_KEEP_ALIVE_TIMEOUT_MS: '9000',
        HTTP_HEADERS_TIMEOUT_MS: '9000',
      }),
    ).toEqual([
      'HTTP_HEADERS_TIMEOUT_MS must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS',
    ]);
  });

  it('has an error message that lists the problems', () => {
    expect(() => loadConfig({})).toThrow(
      /invalid configuration:\n {2}- DATABASE_URL is required/,
    );
  });
});

describe('loadConfig: SQS and workers', () => {
  it('defaults the consumer and the workers to on, with safe limits', () => {
    const { sqs, workers } = loadConfig(minimal);

    expect(sqs).toMatchObject({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      consumer: {
        enabled: true,
        maxMessages: 10,
        waitTimeSeconds: 20,
        maxAttempts: 5,
        retryBaseSeconds: 5,
        retryMaxSeconds: 300,
      },
    });
    expect(workers).toEqual({
      enabled: true,
      outbox: { intervalMs: 1_000, batchSize: 50 },
      pendingReference: { intervalMs: 5_000, batchSize: 50 },
    });
  });

  it('works against real AWS: the endpoint override is optional', () => {
    const { AWS_ENDPOINT_URL: _endpoint, ...withoutEndpoint } = minimal;
    expect(loadConfig(withoutEndpoint).sqs.endpoint).toBeUndefined();
  });

  it('can turn the consumer and the workers off, e.g. for an HTTP-only instance', () => {
    const config = loadConfig({
      ...minimal,
      SQS_CONSUMER_ENABLED: 'false',
      WORKERS_ENABLED: 'false',
    });

    expect(config.sqs.consumer.enabled).toBe(false);
    expect(config.workers.enabled).toBe(false);
  });

  it('requires the three queue urls', () => {
    const { SQS_QUEUE_URL, SQS_DLQ_URL, SQS_EVENTS_QUEUE_URL, ...rest } =
      minimal;
    void [SQS_QUEUE_URL, SQS_DLQ_URL, SQS_EVENTS_QUEUE_URL];

    expect(problemsOf(rest)).toEqual([
      'SQS_QUEUE_URL is required',
      'SQS_DLQ_URL is required',
      'SQS_EVENTS_QUEUE_URL is required',
    ]);
  });

  it('keeps the SQS limits inside what the service allows', () => {
    const problems = problemsOf({
      ...minimal,
      SQS_MAX_MESSAGES: '11',
      SQS_WAIT_TIME_SECONDS: '21',
      SQS_MAX_ATTEMPTS: '0',
      OUTBOX_BATCH_SIZE: '501',
      PENDING_REFERENCE_INTERVAL_MS: '10',
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SQS_MAX_MESSAGES must be <= 10'),
        expect.stringContaining('SQS_WAIT_TIME_SECONDS must be <= 20'),
        expect.stringContaining('SQS_MAX_ATTEMPTS must be >= 1'),
        expect.stringContaining('OUTBOX_BATCH_SIZE must be <= 500'),
        expect.stringContaining('PENDING_REFERENCE_INTERVAL_MS must be >= 50'),
      ]),
    );
  });

  it('rejects a base retry delay above the cap', () => {
    expect(
      problemsOf({
        ...minimal,
        SQS_RETRY_BASE_SECONDS: '600',
        SQS_RETRY_MAX_SECONDS: '60',
      }),
    ).toEqual(['SQS_RETRY_BASE_SECONDS must not exceed SQS_RETRY_MAX_SECONDS']);
  });
});

describe('describeConfig', () => {
  it('never exposes the database password', () => {
    const description = JSON.stringify(describeConfig(loadConfig(minimal)));

    expect(description).not.toContain('s3cret');
    expect(description).toContain('***');
    expect(description).toContain('localhost:5432/jungle');
  });
});
