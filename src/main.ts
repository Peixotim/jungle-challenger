import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap/configure-app.js';
import { registerGracefulShutdown } from './bootstrap/graceful-shutdown.js';
import { APP_CONFIG, describeConfig } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';
import { loadEnvFile } from './config/load-env-file.js';
import { ConfigError } from './config/env.js';
import { LifecycleState } from './infrastructure/lifecycle/LifecycleState.js';
import { JsonLogger } from './infrastructure/observability/JsonLogger.js';
import { PrometheusMetrics } from './infrastructure/observability/PrometheusMetrics.js';

async function bootstrap(): Promise<void> {
  loadEnvFile();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    abortOnError: false,
    bodyParser: false,
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(JsonLogger);

  app.useLogger(logger);
  configureApp(app, config, logger, app.get(PrometheusMetrics));
  registerGracefulShutdown({
    app,
    logger,
    lifecycle: app.get(LifecycleState),
    timeoutMs: config.shutdownTimeoutMs,
  });

  logger.info('starting', describeConfig(config));
  await app.listen(config.http.port, config.http.host);
  logger.info('listening', { host: config.http.host, port: config.http.port });
}

function reportFatal(error: unknown): never {
  const record =
    error instanceof ConfigError
      ? { message: 'invalid configuration', problems: error.problems }
      : {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        };
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'fatal', ...record })}\n`,
  );
  process.exit(1);
}

bootstrap().catch(reportFatal);
