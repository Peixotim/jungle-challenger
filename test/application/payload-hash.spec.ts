import {
  computePayloadHash,
  PayloadFields,
} from '../../src/application/idempotency/payload-hash.js';
import { Money } from '../../src/domain/money/model/Money.js';
import { WagerTransactionKind } from '../../src/domain/wagering/enums/WagerTransactionKind.js';

const fields = (over: Partial<PayloadFields> = {}): PayloadFields => ({
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'r1',
  gameId: 'g1',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  ...over,
});

describe('computePayloadHash', () => {
  it('is a stable SHA-256 hex digest', () => {
    const hash = computePayloadHash(fields());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash(fields())).toBe(hash);
  });

  it('does not depend on property order', () => {
    const a = fields();
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as PayloadFields;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(a));
  });

  it('treats equal money as equal regardless of how it was written', () => {
    const asInteger = fields({
      money: Money.from({ amount: '25', currency: 'BRL' }),
    });
    expect(computePayloadHash(asInteger)).toBe(computePayloadHash(fields()));
  });

  it('ignores transport metadata even when given a wider object', () => {
    const withTransport = {
      ...fields(),
      idempotencyKey: 'provider-a:tx-1',
      correlationId: 'corr-1',
      source: { consumerName: 'wager-consumer', messageId: 'msg-1' },
    };
    expect(computePayloadHash(withTransport)).toBe(
      computePayloadHash(fields()),
    );
  });

  it('treats an absent reference and an undefined one the same', () => {
    expect(
      computePayloadHash(fields({ referenceExternalTransactionId: undefined })),
    ).toBe(computePayloadHash(fields()));
  });

  it.each<[string, Partial<PayloadFields>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'tx-2' }],
    ['playerId', { playerId: 'p2' }],
    ['walletId', { walletId: 'w2' }],
    ['roundId', { roundId: 'r2' }],
    ['gameId', { gameId: 'g2' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['reference', { referenceExternalTransactionId: 'tx-0' }],
  ])('changes when %s changes', (_name, over) => {
    expect(computePayloadHash(fields(over))).not.toBe(
      computePayloadHash(fields()),
    );
  });
});
