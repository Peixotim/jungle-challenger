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
  };

  const { http, database } = config;
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
    },
    database: {
      url: database.toString(),
      poolMin: config.database.poolMin,
      poolMax: config.database.poolMax,
      requireMigrated: config.database.requireMigrated,
    },
    logLevel: config.log.level,
    maxReferenceAttempts: config.processing.maxReferenceAttempts,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  };
}
