import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  Post,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Logger } from '../../src/application/ports/Logger.js';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import { loadConfig } from '../../src/config/app-config.js';
import { JsonLogger } from '../../src/infrastructure/observability/JsonLogger.js';
import { AllExceptionsFilter } from '../../src/interface/http/filters/AllExceptionsFilter.js';

@Controller()
class ProbeController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('health/live')
  live() {
    return { status: 'up' };
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail: connection string xyz');
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpException('short and stout', 418);
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }
}

async function boot(level: 'debug' | 'info' = 'debug') {
  const lines: string[] = [];
  const config = loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    HTTP_BODY_LIMIT: '1kb',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '7000',
    HTTP_HEADERS_TIMEOUT_MS: '8000',
    HTTP_REQUEST_TIMEOUT_MS: '9000',
    LOG_LEVEL: level,
  });
  const logger = new JsonLogger({
    level: config.log.level,
    service: 'probe',
    write: (line) => lines.push(line),
  });

  @Module({
    controllers: [ProbeController],
    providers: [
      { provide: Logger, useValue: logger },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  })
  class ProbeModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [ProbeModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app, config, logger);
  await app.init();
  const records = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, config, records, http: () => request(app.getHttpServer()) };
}

describe('configureApp', () => {
  let current: Awaited<ReturnType<typeof boot>>;

  afterEach(async () => {
    await current.app.close();
  });

  describe('responses', () => {
    beforeEach(async () => {
      current = await boot();
    });

    it('hides the framework and sets conservative security headers', async () => {
      const response = await current.http().get('/ok').expect(200);

      expect(response.headers).not.toHaveProperty('x-powered-by');
      expect(response.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      });
      expect(response.body).toEqual({ ok: true });
    });

    it('generates a correlation id and returns it', async () => {
      const response = await current.http().get('/ok');

      expect(response.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('keeps a well-formed correlation id sent by the caller', async () => {
      const response = await current
        .http()
        .get('/ok')
        .set('X-Correlation-Id', 'provider-a:req-1');

      expect(response.headers['x-correlation-id']).toBe('provider-a:req-1');
    });

    it('replaces a malformed correlation id instead of echoing it', async () => {
      const response = await current
        .http()
        .get('/ok')
        .set('X-Correlation-Id', 'bad id with spaces & symbols');

      expect(response.headers['x-correlation-id']).not.toContain('bad');
      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('errors', () => {
    beforeEach(async () => {
      current = await boot();
    });

    it('answers an unknown route with problem+json and the correlation id', async () => {
      const response = await current.http().get('/nope').expect(404);

      expect(response.headers['content-type']).toMatch(
        /application\/problem\+json/,
      );
      expect(response.body).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: 'Cannot GET /nope',
        correlationId: response.headers['x-correlation-id'],
      });
    });

    it('never leaks the message of an unexpected error', async () => {
      const response = await current.http().get('/boom').expect(500);

      expect(response.body).toMatchObject({
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL_ERROR',
        correlationId: response.headers['x-correlation-id'],
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /secret|connection string/,
      );
    });

    it('logs the unexpected error with the same correlation id', async () => {
      const response = await current.http().get('/boom');

      const failure = current
        .records()
        .find((r) => r.message === 'request failed');
      expect(failure).toMatchObject({
        level: 'error',
        status: 500,
        path: '/boom',
        correlationId: response.headers['x-correlation-id'],
        err: { message: expect.stringContaining('secret internal detail') },
      });
    });

    it('passes the detail of intentional HTTP errors through', async () => {
      const response = await current.http().get('/teapot').expect(418);

      expect(response.body).toMatchObject({
        status: 418,
        code: 'I_M_A_TEAPOT',
        detail: 'short and stout',
      });
    });

    it('rejects malformed JSON as a client error', async () => {
      const response = await current
        .http()
        .post('/echo')
        .set('Content-Type', 'application/json')
        .send('{"broken":')
        .expect(400);

      expect(response.body).toMatchObject({
        status: 400,
        code: 'MALFORMED_JSON',
      });
      expect(response.body.correlationId).toBe(
        response.headers['x-correlation-id'],
      );
    });

    it('rejects a body above the configured limit', async () => {
      const response = await current
        .http()
        .post('/echo')
        .send({ filler: 'x'.repeat(2_000) })
        .expect(413);

      expect(response.body).toMatchObject({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    });

    it('accepts a body within the limit', async () => {
      const response = await current
        .http()
        .post('/echo')
        .send({ hello: 'world' })
        .expect(201);

      expect(response.body).toEqual({ hello: 'world' });
    });
  });

  describe('access log', () => {
    it('logs method, path, status and duration, never the query string', async () => {
      current = await boot();

      const response = await current
        .http()
        .get('/ok?token=super-secret&walletId=1');

      const entry = current.records().find((r) => r.message === 'http request');
      expect(entry).toMatchObject({
        level: 'info',
        method: 'GET',
        path: '/ok',
        status: 200,
        correlationId: response.headers['x-correlation-id'],
      });
      expect(typeof entry?.durationMs).toBe('number');
      expect(JSON.stringify(current.records())).not.toContain('super-secret');
    });

    it('keeps health probes out of the info log', async () => {
      current = await boot('info');

      await current.http().get('/health/live').expect(200);
      await current.http().get('/ok').expect(200);

      const paths = current
        .records()
        .filter((r) => r.message === 'http request')
        .map((r) => r.path);
      expect(paths).toEqual(['/ok']);
    });
  });

  it('applies the configured server timeouts', async () => {
    current = await boot();

    const server = current.app.getHttpServer();
    expect(server.keepAliveTimeout).toBe(7_000);
    expect(server.headersTimeout).toBe(8_000);
    expect(server.requestTimeout).toBe(9_000);
  });
});
