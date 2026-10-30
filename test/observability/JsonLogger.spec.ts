import { JsonLogger } from '../../src/infrastructure/observability/JsonLogger.js';
import { requestContext } from '../../src/infrastructure/observability/request-context.js';

function setup(level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const logger = new JsonLogger({
    level,
    service: 'wagering-test',
    write: (line) => lines.push(line),
  });
  const records = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('JsonLogger', () => {
  it('writes one JSON object per line with the standard fields', () => {
    const { logger, lines, records } = setup();

    logger.info('wallet created', { walletId: 'w1' });

    expect(lines).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      level: 'info',
      service: 'wagering-test',
      message: 'wallet created',
      walletId: 'w1',
    });
    expect(new Date(records()[0].time as string).toISOString()).toBe(
      records()[0].time,
    );
  });

  it('filters below the configured level', () => {
    const { logger, records } = setup('warn');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(records().map((r) => r.message)).toEqual(['w', 'e']);
  });

  it('adds the correlation id of the current request', () => {
    const { logger, records } = setup();

    requestContext.run({ correlationId: 'corr-42' }, () =>
      logger.info('inside'),
    );
    logger.info('outside');

    expect(records()[0].correlationId).toBe('corr-42');
    expect(records()[1]).not.toHaveProperty('correlationId');
  });

  it('redacts secrets and whole payloads, at any depth', () => {
    const { logger, lines, records } = setup();

    logger.info('call', {
      password: 'hunter2',
      headers: { authorization: 'Bearer abc', accept: 'json' },
      nested: { deep: { apiKey: 'k', sessionToken: 't', safe: 1 } },
      payload: { money: { amount: '25.00' } },
      body: '{"raw":true}',
    });

    const record = records()[0];
    expect(record.password).toBe('[REDACTED]');
    expect(record.payload).toBe('[REDACTED]');
    expect(record.body).toBe('[REDACTED]');
    expect(record.headers).toEqual({
      authorization: '[REDACTED]',
      accept: 'json',
    });
    expect(record.nested).toEqual({
      deep: { apiKey: '[REDACTED]', sessionToken: '[REDACTED]', safe: 1 },
    });
    expect(lines[0]).not.toMatch(/hunter2|Bearer abc|25\.00/);
  });

  it('serializes errors with name, message and stack', () => {
    const { logger, records } = setup();

    logger.error('failed', { err: new RangeError('out of range') });

    expect(records()[0].err).toMatchObject({
      name: 'RangeError',
      message: 'out of range',
      stack: expect.stringContaining('RangeError'),
    });
  });

  it('accepts an Error as the message', () => {
    const { logger, records } = setup();

    logger.error(new Error('boom'));

    expect(records()[0]).toMatchObject({
      message: 'boom',
      err: { message: 'boom' },
    });
  });

  it('understands the NestJS logger calling convention', () => {
    const { logger, records } = setup('debug');

    logger.log('started', 'NestApplication');
    logger.error(
      'crashed',
      'Error: x\n    at thing (file.ts:1:1)',
      'AppModule',
    );
    logger.verbose('details', 'Router');

    expect(records()[0]).toMatchObject({
      level: 'info',
      context: 'NestApplication',
      message: 'started',
    });
    expect(records()[1]).toMatchObject({
      level: 'error',
      context: 'AppModule',
      stack: expect.stringContaining('at thing'),
    });
    expect(records()[2]).toMatchObject({ level: 'debug', context: 'Router' });
  });

  it('does not let fields overwrite the standard keys', () => {
    const { logger, records } = setup();

    logger.info('real', {
      level: 'fake',
      message: 'fake',
      service: 'fake',
      time: 'fake',
    });

    expect(records()[0]).toMatchObject({
      level: 'info',
      message: 'real',
      service: 'wagering-test',
    });
    expect(records()[0].time).not.toBe('fake');
  });

  it('survives bigint, dates, circular references and very long strings', () => {
    const { logger, records } = setup();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() =>
      logger.info('odd', {
        big: 10n,
        at: new Date('2026-01-01T00:00:00Z'),
        circular,
        long: 'x'.repeat(5_000),
      }),
    ).not.toThrow();

    const record = records()[0];
    expect(record.big).toBe('10');
    expect(record.at).toBe('2026-01-01T00:00:00.000Z');
    expect(JSON.stringify(record.circular)).toContain('[Truncated]');
    expect((record.long as string).length).toBeLessThan(2_100);
  });

  it('keeps a fatal level that is always written', () => {
    const { logger, records } = setup('error');

    logger.fatal('dead');

    expect(records()[0].level).toBe('fatal');
  });
});
