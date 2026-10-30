import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import { APP_CONFIG } from '../../src/config/app-config.js';
import type { AppConfig } from '../../src/config/app-config.js';
import { JsonLogger } from '../../src/infrastructure/observability/JsonLogger.js';
import { PrometheusMetrics } from '../../src/infrastructure/observability/PrometheusMetrics.js';

export async function createApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  return moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
}

export async function startApp(): Promise<NestExpressApplication> {
  const app = await createApp();
  configureApp(
    app,
    app.get<AppConfig>(APP_CONFIG),
    app.get(JsonLogger),
    app.get(PrometheusMetrics),
  );
  await app.init();
  return app;
}
