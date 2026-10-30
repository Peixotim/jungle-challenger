import { IdempotencyConflictError } from '../../src/application/errors/application-errors.js';
import { MessageOutcomePolicy } from '../../src/application/services/MessageOutcomePolicy.js';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionError,
  InvalidWalletError,
} from '../../src/domain/errors/domain-errors.js';

const policy = (over = {}) =>
  new MessageOutcomePolicy({
    maxAttempts: 5,
    retryBaseSeconds: 5,
    retryMaxSeconds: 300,
    ...over,
  });

describe('MessageOutcomePolicy', () => {
  describe('permanent failures go straight to the dead-letter queue', () => {
    it.each([
      [new IdempotencyConflictError('PAYLOAD_MISMATCH', 'k'), 'CONFLICT'],
      [new InvalidMoneyError('bad'), 'INVALID'],
      [new InvalidTransactionError('bad'), 'INVALID'],
      [new InvalidWalletError('bad'), 'INVALID'],
      [new CurrencyMismatchError('BRL', 'USD'), 'INVALID'],
    ])('%s', (error, reason) => {
      expect(policy().decide(error, 1)).toEqual({
        kind: 'dead-letter',
        reason,
      });
    });

    it('does not spend retries on them, even on the first delivery', () => {
      expect(
        policy({ maxAttempts: 20 }).decide(new InvalidMoneyError('x'), 1),
      ).toMatchObject({
        kind: 'dead-letter',
      });
    });
  });

  describe('everything else is retried with exponential backoff', () => {
    it('backs off 5s, 10s, 20s, 40s', () => {
      const p = policy();
      const delays = [1, 2, 3, 4].map(
        (n) =>
          (p.decide(new Error('db down'), n) as { delaySeconds: number })
            .delaySeconds,
      );
      expect(delays).toEqual([5, 10, 20, 40]);
    });

    it('caps the delay', () => {
      const p = policy({ maxAttempts: 50, retryMaxSeconds: 60 });
      expect(p.decide(new Error('x'), 30)).toEqual({
        kind: 'retry',
        delaySeconds: 60,
      });
    });

    it('treats unknown errors like transient ones: they are retried, not lost', () => {
      expect(
        policy().decide(new InsufficientFundsError('programming error'), 1),
      ).toMatchObject({
        kind: 'retry',
      });
      expect(policy().decide('a string was thrown', 1)).toMatchObject({
        kind: 'retry',
      });
    });
  });

  describe('attempt limit', () => {
    it('dead-letters on the last allowed attempt instead of retrying again', () => {
      const p = policy({ maxAttempts: 3 });

      expect(p.decide(new Error('x'), 2)).toMatchObject({ kind: 'retry' });
      expect(p.decide(new Error('x'), 3)).toEqual({
        kind: 'dead-letter',
        reason: 'RETRIES_EXHAUSTED',
      });
      expect(p.decide(new Error('x'), 9)).toMatchObject({
        reason: 'RETRIES_EXHAUSTED',
      });
    });

    it('a limit of 1 never retries', () => {
      expect(
        policy({ maxAttempts: 1 }).decide(new Error('x'), 1),
      ).toMatchObject({
        reason: 'RETRIES_EXHAUSTED',
      });
    });
  });

  it('allows retrying immediately when the base delay is zero', () => {
    expect(policy({ retryBaseSeconds: 0 }).decide(new Error('x'), 2)).toEqual({
      kind: 'retry',
      delaySeconds: 0,
    });
  });
});
