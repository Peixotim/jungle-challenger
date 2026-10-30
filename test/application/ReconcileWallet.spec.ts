import { WalletNotFoundError } from '../../src/application/errors/application-errors.js';
import { ReconcileWallet } from '../../src/application/use-cases/ReconcileWallet.js';
import { SubmitWagerTransaction } from '../../src/application/use-cases/SubmitWagerTransaction.js';
import { Money } from '../../src/domain/money/model/Money.js';
import { command, harness, money, next } from './fakes/harness.js';

function setup() {
  const h = harness({ balance: '1000.00' });
  return {
    ...h,
    submit: new SubmitWagerTransaction(h.db.uow, h.clock, h.ids, h.processor),
    reconcile: new ReconcileWallet(h.db.uow, h.metrics, h.logger),
  };
}

describe('ReconcileWallet', () => {
  it('reports a consistent wallet', async () => {
    const { submit, reconcile, metrics, logger } = setup();
    await submit.execute(command());
    await submit.execute(next('tx-2', { money: money('10.00') }));

    const result = await reconcile.execute('w1');

    expect(result).toEqual({
      walletId: 'w1',
      storedBalance: money('965.00'),
      calculatedBalance: money('965.00'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 3,
    });
    expect(metrics.counters).toEqual([
      {
        name: 'wallet_reconciliations_total',
        labels: { result: 'consistent' },
      },
    ]);
    expect(logger.entries).toHaveLength(0);
  });

  it('flags a divergence: logged, counted, returned, and NOT corrected', async () => {
    const { db, reconcile, metrics, logger } = setup();
    db.wallets.get('w1')!.credit({
      entryId: 'lost-entry',
      transactionId: 'lost-tx',
      money: Money.from(money('40.00')),
      at: new Date(),
    });

    const result = await reconcile.execute('w1');

    expect(result).toMatchObject({
      storedBalance: money('1040.00'),
      calculatedBalance: money('1000.00'),
      difference: money('40.00'),
      consistent: false,
      checkedEntries: 1,
    });
    expect(metrics.counters).toEqual([
      { name: 'wallet_reconciliations_total', labels: { result: 'divergent' } },
    ]);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'error',
      fields: { walletId: 'w1', difference: '40.00 BRL' },
    });
    expect(db.wallets.get('w1')!.balance.toJSON()).toEqual(money('1040.00'));
    expect(db.ledger).toHaveLength(1);
  });

  it('reports a negative difference when the ledger exceeds the wallet', async () => {
    const { db, reconcile } = setup();
    db.wallets.set(
      'w1',
      (() => {
        const w = db.wallets.get('w1')!;
        w.debit({
          entryId: 'x',
          transactionId: 'x',
          money: Money.from(money('10.00')),
          at: new Date(),
        });
        return w;
      })(),
    );

    const result = await reconcile.execute('w1');

    expect(result.difference).toEqual(money('-10.00'));
    expect(result.consistent).toBe(false);
  });

  it('fails for an unknown wallet', async () => {
    const { reconcile } = setup();
    await expect(reconcile.execute('nope')).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});
