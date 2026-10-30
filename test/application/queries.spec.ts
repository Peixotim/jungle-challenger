import {
  InvalidQueryError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from '../../src/application/errors/application-errors.js';
import { GetWagerTransaction } from '../../src/application/use-cases/GetWagerTransaction.js';
import { GetWallet } from '../../src/application/use-cases/GetWallet.js';
import { GetWalletLedger } from '../../src/application/use-cases/GetWalletLedger.js';
import { SubmitWagerTransaction } from '../../src/application/use-cases/SubmitWagerTransaction.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { command, harness, money, next } from './fakes/harness.js';

function setup() {
  const { db, clock, ids, processor } = harness({ balance: '1000.00' });
  return {
    db,
    submit: new SubmitWagerTransaction(db.uow, clock, ids, processor),
    getWallet: new GetWallet(db.uow),
    getLedger: new GetWalletLedger(db.uow),
    getTransaction: new GetWagerTransaction(db.uow),
  };
}

describe('GetWallet', () => {
  it('returns id, player, balance and version', async () => {
    const { submit, getWallet } = setup();
    await submit.execute(command());

    expect(await getWallet.execute('w1')).toEqual({
      id: 'w1',
      playerId: 'p1',
      balance: money('975.00'),
      version: 2,
    });
  });

  it('fails for an unknown wallet', async () => {
    const { getWallet } = setup();
    await expect(getWallet.execute('nope')).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});

describe('GetWalletLedger', () => {
  async function withEntries() {
    const ctx = setup();
    await ctx.submit.execute(command());
    await ctx.submit.execute(next('tx-2'));
    await ctx.submit.execute(next('tx-3'));
    return ctx;
  }

  it('returns entries as plain views, oldest first', async () => {
    const { getLedger } = await withEntries();

    const page = await getLedger.execute('w1');

    expect(page.entries).toHaveLength(4);
    expect(page.nextCursor).toBeUndefined();
    expect(page.entries[0]).toMatchObject({
      direction: 'CREDIT',
      balanceAfter: money('1000.00'),
    });
    expect(page.entries[3]).toMatchObject({
      direction: 'DEBIT',
      money: money('25.00'),
      balanceBefore: money('950.00'),
      balanceAfter: money('925.00'),
    });
  });

  it('pages with an opaque cursor without skipping or repeating entries', async () => {
    const { getLedger } = await withEntries();

    const first = await getLedger.execute('w1', { limit: 3 });
    expect(first.entries).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();

    const second = await getLedger.execute('w1', {
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();

    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
  });

  it.each([0, -1, 201, 1.5, Number.NaN])('rejects limit %s', async (limit) => {
    const { getLedger } = setup();
    await expect(getLedger.execute('w1', { limit })).rejects.toBeInstanceOf(
      InvalidQueryError,
    );
  });

  it('fails for an unknown wallet', async () => {
    const { getLedger } = setup();
    await expect(getLedger.execute('nope')).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});

describe('GetWagerTransaction', () => {
  it('finds by internal id and by provider transaction id', async () => {
    const { submit, getTransaction } = setup();
    const { transactionId } = await submit.execute(command());

    const byId = await getTransaction.byId(transactionId);
    const byExternal = await getTransaction.byExternalId('provider-a', 'tx-1');

    expect(byExternal).toEqual(byId);
    expect(byId).toMatchObject({
      transactionId,
      status: WagerTransactionStatus.Processed,
      kind: 'BET',
      money: money('25.00'),
      balance: money('975.00'),
    });
  });

  it('exposes the failure code of a rejection', async () => {
    const { submit, getTransaction } = setup();
    const { transactionId } = await submit.execute(
      command({ money: money('5000.00') }),
    );

    expect(await getTransaction.byId(transactionId)).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('fails for unknown transactions', async () => {
    const { getTransaction } = setup();
    await expect(getTransaction.byId('nope')).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
    await expect(
      getTransaction.byExternalId('provider-a', 'nope'),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
  });
});
