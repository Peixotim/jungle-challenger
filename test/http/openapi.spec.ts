import { Module, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import { loadConfig } from '../../src/config/app-config.js';
import { HealthController } from '../../src/interface/http/controllers/HealthController.js';
import { MetricsController } from '../../src/interface/http/controllers/MetricsController.js';
import { WageringController } from '../../src/interface/http/controllers/WageringController.js';
import { WalletsController } from '../../src/interface/http/controllers/WalletsController.js';
import { buildOpenApiDocument } from '../../src/interface/http/openapi/openapi-document.js';
import { JsonLogger } from '../../src/infrastructure/observability/JsonLogger.js';
import { PrometheusMetrics } from '../../src/infrastructure/observability/PrometheusMetrics.js';
import { SQS_TEST_ENV } from '../support/test-env.js';

const CONTROLLERS = [
  WalletsController,
  WageringController,
  HealthController,
  MetricsController,
];

// "GET /wallets/{walletId}" for every handler declared on the controllers.
function declaredRoutes(): string[] {
  return CONTROLLERS.flatMap((controller) => {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
      const handler = (
        controller.prototype as unknown as Record<string, object>
      )[name]!;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (path === undefined || method === undefined) return [];
      const full = `/${[base, path].filter((part) => part && part !== '/').join('/')}`;
      return `${RequestMethod[method]} ${full.replace(/:(\w+)/g, '{$1}')}`;
    });
  });
}

function documentedRoutes(): string[] {
  const { paths } = buildOpenApiDocument();
  return Object.entries(paths).flatMap(([path, item]) =>
    Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
  );
}

describe('OpenAPI document', () => {
  it('documents every route the controllers declare, and nothing else', () => {
    expect(documentedRoutes().sort()).toEqual(declaredRoutes().sort());
  });

  it('derives the submit body from the validation schema', () => {
    const { schemas } = buildOpenApiDocument().components!;
    const submit = (
      buildOpenApiDocument().paths['/wagering/transactions'].post!
        .requestBody as {
        content: {
          'application/json': {
            schema: {
              required: string[];
              additionalProperties: boolean;
              properties: { kind: { enum: string[] } };
            };
          };
        };
      }
    ).content['application/json'].schema;

    expect(submit.additionalProperties).toBe(false);
    expect(submit.required).toEqual(
      expect.arrayContaining(['walletId', 'kind', 'money']),
    );
    expect(submit.required).not.toContain('referenceExternalTransactionId');
    expect(submit.properties.kind.enum).toEqual([
      'BET',
      'WIN',
      'LOSS',
      'REFUND',
      'ROLLBACK',
    ]);
    expect(schemas).toHaveProperty('Problem');
  });

  it('only references schemas it defines', () => {
    const document = buildOpenApiDocument();
    const refs = [
      ...JSON.stringify(document).matchAll(/#\/components\/schemas\/(\w+)/g),
    ];

    expect(refs.length).toBeGreaterThan(0);
    for (const [, name] of refs) {
      expect(document.components!.schemas).toHaveProperty(name);
    }
  });
});

describe('docs endpoint', () => {
  let app: NestExpressApplication;

  async function boot(env: Record<string, string> = {}) {
    const config = loadConfig({
      ...SQS_TEST_ENV,
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      LOG_LEVEL: 'error',
      ...env,
    });
    const logger = new JsonLogger({
      level: 'error',
      service: 'probe',
      write: () => {},
    });
    @Module({})
    class EmptyModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [EmptyModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, config, logger, new PrometheusMetrics());
    await app.init();
    return request(app.getHttpServer());
  }

  afterEach(async () => {
    await app.close();
  });

  it('serves the document and the UI with a CSP that lets the UI run', async () => {
    const http = await boot();

    const json = await http.get('/docs-json').expect(200);
    expect(json.body.info.title).toBe('Wagering Processor API');
    expect(json.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );

    const page = await http.get('/docs').expect(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
  });

  it('is off when DOCS_ENABLED=false', async () => {
    const http = await boot({ DOCS_ENABLED: 'false' });

    await http.get('/docs-json').expect(404);
    await http.get('/docs').expect(404);
  });

  it('is off by default in production', async () => {
    const http = await boot({ NODE_ENV: 'production' });

    await http.get('/docs-json').expect(404);
  });
});
