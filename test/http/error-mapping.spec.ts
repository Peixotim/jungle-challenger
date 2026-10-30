import { DeadlockException, ConnectionException } from '@mikro-orm/core';
import { HttpException } from '@nestjs/common';
import {
  IdempotencyConflictError,
  InvalidQueryError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors/application-errors.js';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionError,
  InvalidWalletError,
} from '../../src/domain/errors/domain-errors.js';
import { OptimisticLockError } from '../../src/infrastructure/persistence/errors.js';
import { classifyTransient } from '../../src/infrastructure/persistence/transient-errors.js';
import { mapKnownError } from '../../src/interface/http/error-mapping.js';
import { toProblem } from '../../src/interface/http/problem.js';

describe('mapKnownError', () => {
  it.each([
    [
      new IdempotencyConflictError('PAYLOAD_MISMATCH', 'k'),
      409,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    ],
    [
      new IdempotencyConflictError('EXTERNAL_ID_REUSED', 'k'),
      409,
      'IDEMPOTENCY_EXTERNAL_ID_REUSED',
    ],
    [new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS'],
    [new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    [new TransactionNotFoundError('t'), 404, 'TRANSACTION_NOT_FOUND'],
    [new InvalidQueryError('bad'), 400, 'INVALID_QUERY'],
    [new InvalidMoneyError('bad'), 400, 'INVALID_MONEY'],
    [new CurrencyMismatchError('BRL', 'USD'), 400, 'CURRENCY_MISMATCH'],
    [new InvalidTransactionError('bad'), 400, 'INVALID_TRANSACTION'],
    [new InvalidWalletError('bad'), 400, 'INVALID_WALLET'],
  ])('maps %s', (error, status, code) => {
    expect(mapKnownError(error)).toMatchObject({ status, code });
  });

  it('maps transient database failures to 503', () => {
    expect(
      mapKnownError(new OptimisticLockError('wallet', 'w1')),
    ).toMatchObject({
      status: 503,
      code: 'TEMPORARILY_UNAVAILABLE',
    });
  });

  it('leaves programming errors and unknown errors unmapped', () => {
    expect(mapKnownError(new InsufficientFundsError('x'))).toBeUndefined();
    expect(mapKnownError(new Error('boom'))).toBeUndefined();
    expect(mapKnownError('string')).toBeUndefined();
    expect(mapKnownError(undefined)).toBeUndefined();
  });
});

describe('classifyTransient', () => {
  it('recognizes lock conflicts by class and by SQLSTATE', () => {
    expect(classifyTransient(new OptimisticLockError('wallet', 'w'))).toBe(
      'lock_conflict',
    );
    expect(
      classifyTransient(new DeadlockException(new Error('deadlock'))),
    ).toBe('lock_conflict');
    expect(classifyTransient({ code: '40P01' })).toBe('lock_conflict');
    expect(classifyTransient({ code: '40001' })).toBe('lock_conflict');
    expect(classifyTransient({ code: '55P03' })).toBe('lock_conflict');
  });

  it('recognizes unavailability by class, SQLSTATE and network code', () => {
    expect(classifyTransient(new ConnectionException(new Error('down')))).toBe(
      'unavailable',
    );
    expect(classifyTransient({ code: '57P01' })).toBe('unavailable');
    expect(classifyTransient({ code: '53300' })).toBe('unavailable');
    expect(classifyTransient({ code: 'ECONNREFUSED' })).toBe('unavailable');
  });

  it.each([
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
  ])(
    'recognizes the connection-pool error "%s", which carries no code (a stopped server)',
    (message) => {
      expect(classifyTransient(new Error(message))).toBe('unavailable');
      expect(
        classifyTransient(new Error('outer', { cause: new Error(message) })),
      ).toBe('unavailable');
    },
  );

  it('does not mistake an unrelated message for an outage', () => {
    expect(
      classifyTransient(new Error('syntax error at or near "selec"')),
    ).toBeUndefined();
    expect(
      classifyTransient(new Error('the connection string is invalid')),
    ).toBeUndefined();
  });

  it('looks through wrapped causes', () => {
    expect(
      classifyTransient(new Error('outer', { cause: { code: '40P01' } })),
    ).toBe('lock_conflict');
    expect(
      classifyTransient({ cause: { cause: { code: 'ECONNRESET' } } }),
    ).toBe('unavailable');
  });

  it('does not treat business or constraint errors as transient', () => {
    expect(classifyTransient({ code: '23505' })).toBeUndefined();
    expect(classifyTransient(new Error('plain'))).toBeUndefined();
    expect(classifyTransient(null)).toBeUndefined();
  });

  it('survives circular causes', () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(classifyTransient(loop)).toBeUndefined();
  });
});

describe('toProblem', () => {
  it('maps domain and application errors', () => {
    expect(toProblem(new WalletNotFoundError('w1'), 'corr-1')).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'WALLET_NOT_FOUND',
      detail: 'wallet w1 not found',
      correlationId: 'corr-1',
    });
  });

  it('carries field errors of a validation exception', () => {
    const problem = toProblem(
      new HttpException(
        {
          code: 'VALIDATION_ERROR',
          message: 'request validation failed',
          errors: [{ path: 'body.playerId', message: 'invalid uuid' }],
        },
        400,
      ),
    );

    expect(problem).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      errors: [{ path: 'body.playerId', message: 'invalid uuid' }],
    });
  });

  it('hides everything about unexpected errors', () => {
    const problem = toProblem(new Error('password=hunter2 host=db.internal'));

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('hides the message of server-side HttpExceptions too', () => {
    expect(
      toProblem(new HttpException('stack at /srv/app', 502)),
    ).toMatchObject({
      status: 502,
      code: 'INTERNAL_ERROR',
    });
    expect(
      JSON.stringify(toProblem(new HttpException('stack at /srv/app', 502))),
    ).not.toContain('/srv/app');
  });
});
