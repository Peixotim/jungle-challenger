import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../config/app-config.js';
import { Logger } from '../application/ports/Logger.js';
import { Metrics } from '../application/ports/Metrics.js';
import { accessLogMiddleware } from '../interface/http/middleware/access-log.middleware.js';
import {
  jsonBodyErrorHandler,
  jsonBodyParser,
} from '../interface/http/middleware/json-body.middleware.js';
import { requestContextMiddleware } from '../interface/http/middleware/request-context.middleware.js';
import { securityHeadersMiddleware } from '../interface/http/middleware/security-headers.middleware.js';

export function configureApp(
  app: NestExpressApplication,
  config: AppConfig,
  logger: Logger,
  metrics: Metrics,
): void {
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);

  app.use(requestContextMiddleware);
  app.use(securityHeadersMiddleware);
  app.use(accessLogMiddleware(logger, metrics));
  app.use(jsonBodyParser(config.http.bodyLimit));
  app.use(jsonBodyErrorHandler);

  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  server.headersTimeout = config.http.headersTimeoutMs;
  server.requestTimeout = config.http.requestTimeoutMs;
}
