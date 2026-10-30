import { HttpException } from '@nestjs/common';
import {
  createWalletBody,
  idempotencyKeyHeader,
  ledgerQuery,
  submitTransactionBody,
} from '../../src/interface/http/validation/schemas.js';
import { ZodPipe } from '../../src/interface/http/validation/ZodPipe.js';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

const validSubmit = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: PLAYER,
  walletId: WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const failures = (pipe: ZodPipe<unknown>, value: unknown) => {
  try {
    pipe.transform(value);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(400);
    return (
      http.getResponse() as { errors: { path: string; message: string }[] }
    ).errors;
  }
  throw new Error('expected validation to fail');
};

describe('createWalletBody', () => {
  const pipe = new ZodPipe(createWalletBody, 'body');

  it('accepts the contract from the challenge', () => {
    expect(
      pipe.transform({
        playerId: PLAYER,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      }),
    ).toEqual({
      playerId: PLAYER,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
  });

  it('normalizes the player id to lowercase', () => {
    const result = pipe.transform({
      playerId: PLAYER.toUpperCase(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(result.playerId).toBe(PLAYER);
  });

  it('reports the path of every invalid field', () => {
    const errors = failures(pipe, {
      playerId: 'nope',
      initialBalance: { amount: 10 },
    });

    expect(errors.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        'body.playerId',
        'body.initialBalance.amount',
        'body.initialBalance.currency',
      ]),
    );
  });

  it('rejects unknown properties, so a typo never silently disappears', () => {
    const errors = failures(pipe, {
      playerId: PLAYER,
      initialBalance: { amount: '1.00', currency: 'BRL' },
      initialBallance: 1,
    });
    expect(errors).toHaveLength(1);
  });

  it('rejects a body that is not an object', () => {
    failures(pipe, undefined);
    failures(pipe, 'text');
    failures(pipe, []);
  });
});

describe('submitTransactionBody', () => {
  const pipe = new ZodPipe(submitTransactionBody, 'body');

  it('accepts every provider-facing kind', () => {
    for (const kind of ['BET', 'WIN', 'LOSS']) {
      expect(pipe.transform({ ...validSubmit, kind }).kind).toBe(kind);
    }
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect(
        pipe.transform({
          ...validSubmit,
          kind,
          referenceExternalTransactionId: 'transaction-1',
        }).kind,
      ).toBe(kind);
    }
  });

  it('refuses the internal OPENING kind', () => {
    const errors = failures(pipe, { ...validSubmit, kind: 'OPENING' });
    expect(errors[0].path).toBe('body.kind');
  });

  it('lets money validation be decided by Money, not by the schema', () => {
    expect(
      pipe.transform({
        ...validSubmit,
        money: { amount: '25.001', currency: 'BRL' },
      }).money.amount,
    ).toBe('25.001');
  });

  it.each(['providerId', 'externalTransactionId', 'roundId', 'gameId'])(
    'requires a non-empty %s',
    (field) => {
      expect(failures(pipe, { ...validSubmit, [field]: '' })[0].path).toBe(
        `body.${field}`,
      );
      expect(
        failures(pipe, { ...validSubmit, [field]: undefined })[0].path,
      ).toBe(`body.${field}`);
    },
  );

  it('bounds the size of free-text fields', () => {
    failures(pipe, { ...validSubmit, providerId: 'x'.repeat(101) });
    failures(pipe, { ...validSubmit, externalTransactionId: 'x'.repeat(201) });
  });

  it('requires uuids for player and wallet', () => {
    expect(failures(pipe, { ...validSubmit, playerId: 'p1' })[0].path).toBe(
      'body.playerId',
    );
    expect(failures(pipe, { ...validSubmit, walletId: 'w1' })[0].path).toBe(
      'body.walletId',
    );
  });

  it('rejects unknown properties', () => {
    failures(pipe, { ...validSubmit, extra: true });
  });
});

describe('idempotencyKeyHeader', () => {
  const pipe = new ZodPipe(idempotencyKeyHeader, 'header');

  it('accepts the recommended provider:transaction format', () => {
    expect(pipe.transform('provider-a:transaction-123')).toBe(
      'provider-a:transaction-123',
    );
  });

  it('requires the header, with an actionable message', () => {
    expect(failures(pipe, undefined)).toEqual([
      { path: 'header', message: 'the Idempotency-Key header is required' },
    ]);
  });

  it.each(['', 'has space', 'tab\there', 'x'.repeat(256), 'accentuação'])(
    'rejects %j',
    (value) => {
      failures(pipe, value);
    },
  );
});

describe('ledgerQuery', () => {
  const pipe = new ZodPipe(ledgerQuery, 'query');

  it('coerces the limit from the query string', () => {
    expect(pipe.transform({ limit: '50', cursor: 'abc' })).toEqual({
      limit: 50,
      cursor: 'abc',
    });
    expect(pipe.transform({})).toEqual({});
  });

  it.each(['0', '-1', '201', '1.5', 'abc'])('rejects limit %s', (limit) => {
    expect(failures(pipe, { limit })[0].path).toBe('query.limit');
  });

  it('rejects unknown query parameters', () => {
    failures(pipe, { page: '2' });
  });
});
