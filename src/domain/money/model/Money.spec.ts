import { CurrencyMismatchError, InvalidMoneyError } from '../../errors/domain-errors.js';
import { Money } from './Money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('from', () => {
    it('normalizes scale to 2 decimals', () => {
      expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(brl('25.5').toJSON().amount).toBe('25.50');
    });

    it.each(['', ' ', 'NaN', 'Infinity', '1e3', '1.001', '-1.00', '+1.00', '1,00', '.5', 'abc'])(
      'rejects invalid amount %j',
      (amount) => {
        expect(() => brl(amount)).toThrow(InvalidMoneyError);
      },
    );

    it('rejects non-string amount', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it.each(['', 'br', 'brl', 'BRLL', 'B1L'])('rejects invalid currency %j', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts exactly (no float drift)', () => {
      expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    });

    it('is immutable', () => {
      const a = brl('10.00');
      a.add(brl('5.00'));
      expect(a.toJSON().amount).toBe('10.00');
    });

    it('allows negative results internally', () => {
      const m = brl('10.00').subtract(brl('25.00'));
      expect(m.isNegative()).toBe(true);
      expect(m.toJSON().amount).toBe('-15.00');
      expect(m.negate().toJSON().amount).toBe('15.00');
    });

    it('never produces negative zero', () => {
      const z = Money.zero('BRL').negate();
      expect(z.isNegative()).toBe(false);
      expect(z.toJSON().amount).toBe('0.00');
      expect(brl('5.00').subtract(brl('5.00')).toJSON().amount).toBe('0.00');
    });
  });

  describe('predicates', () => {
    it('isZero / isPositive / isNegative', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
    });

    it('isLessThan', () => {
      expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
      expect(brl('2.00').isLessThan(brl('2.00'))).toBe(false);
    });

    it('equals compares value and currency', () => {
      expect(brl('1.00').equals(brl('1'))).toBe(true);
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('currency mismatch', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it('add / subtract / isLessThan throw', () => {
      expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    });
  });

  it('serializes', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
    expect(JSON.stringify({ m: brl('25') })).toBe('{"m":{"amount":"25.00","currency":"BRL"}}');
  });
});
