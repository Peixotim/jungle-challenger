import { WalletAlreadyExistsError } from '../../src/application/errors/application-errors.js';
import { CreateWallet } from '../../src/application/use-cases/CreateWallet.js';
import { InvalidMoneyError } from '../../src/domain/errors/domain-errors.js';
import { LedgerDirection } from '../../src/domain/ledger/enums/LedgerDirection.js';
import { WagerTransactionKind } from '../../src/domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { harness, money } from './fakes/harness.js';

function setup() {
  const { db, clock, ids } = harness();
  return { db, useCase: new CreateWallet(db.uow, clock, ids) };
}

const create = (over = {}) => ({
  playerId: 'p1',
  initialBalance: money('1000.00'),
  correlationId: 'corr-1',
  ...over,
});

describe('CreateWallet', () => {
  it('opens at version 1 with the initial balance', async () => {
    const { useCase } = setup();

    const wallet = await useCase.execute(create());

    expect(wallet).toMatchObject({
      playerId: 'p1',
      balance: money('1000.00'),
      version: 1,
    });
  });

  it('records an OPENING transaction and its CREDIT entry atomically with the wallet', async () => {
    const { db, useCase } = setup();

    const view = await useCase.execute(create());

    const [entry] = db.ledger;
    expect(db.ledger).toHaveLength(1);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.isZero()).toBe(true);
    expect(entry.walletId).toBe(view.id);

    const [opening] = [...db.transactions.values()];
    expect(opening).toMatchObject({
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      walletId: view.id,
    });
    expect(entry.transactionId).toBe(opening.id);
    expect(opening.observedBalance?.toJSON()).toEqual(money('1000.00'));
    expect(db.eventTypes()).toEqual([
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
    ]);
    expect(
      db.ledgerBalance(view.id).equals(db.wallets.get(view.id)!.balance),
    ).toBe(true);
  });

  it('a zero balance opens without OPENING, ledger entry or events', async () => {
    const { db, useCase } = setup();

    const wallet = await useCase.execute(
      create({ initialBalance: money('0.00') }),
    );

    expect(wallet.version).toBe(1);
    expect(db.ledger).toHaveLength(0);
    expect(db.transactions.size).toBe(0);
    expect(db.outbox).toHaveLength(0);
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const { db, useCase } = setup();
    await useCase.execute(create());

    await expect(useCase.execute(create())).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );
    expect(db.wallets.size).toBe(1);
    expect(db.ledger).toHaveLength(1);
  });

  it('allows other currencies and other players', async () => {
    const { db, useCase } = setup();
    await useCase.execute(create());

    await useCase.execute(
      create({ initialBalance: { amount: '5.00', currency: 'USD' } }),
    );
    await useCase.execute(create({ playerId: 'p2' }));

    expect(db.wallets.size).toBe(3);
  });

  it('rejects invalid money before touching anything', async () => {
    const { db, useCase } = setup();

    await expect(
      useCase.execute(create({ initialBalance: money('-1.00') })),
    ).rejects.toThrow(InvalidMoneyError);
    await expect(
      useCase.execute(create({ initialBalance: money('1.001') })),
    ).rejects.toThrow(InvalidMoneyError);
    expect(db.wallets.size).toBe(0);
  });
});
