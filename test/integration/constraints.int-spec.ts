import { randomUUID } from 'node:crypto';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/enums/WagerTransactionKind.js';
import {
  App,
  buildApp,
  money,
  OpenedWallet,
  openWallet,
  operation,
} from './support/app.js';
import { connectTestDatabase, TestDatabase } from './support/database.js';

describe('database constraints', () => {
  let db: TestDatabase;
  let app: App;
  let wallet: OpenedWallet;
  let bet: { transactionId: string; externalTransactionId: string };

  beforeAll(async () => {
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    app = buildApp(db);
    wallet = await openWallet(app, '100.00');
    const command = operation(wallet);
    const result = await app.submit.execute(command);
    bet = {
      transactionId: result.transactionId,
      externalTransactionId: command.externalTransactionId,
    };
  });

  const expectRefused = (sql: string, params: unknown[], reason: RegExp) =>
    expect(db.query(sql, params)).rejects.toThrow(reason);

  const insertEntry = (over: Partial<Record<string, string>> = {}) => {
    const entry = {
      transaction_id: bet.transactionId,
      direction: 'DEBIT',
      amount: '10.00',
      currency: 'BRL',
      balance_before: '75.00',
      balance_after: '65.00',
      ...over,
    };
    return [
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
      [
        randomUUID(),
        wallet.id,
        entry.transaction_id,
        entry.direction,
        entry.amount,
        entry.currency,
        entry.balance_before,
        entry.balance_after,
      ],
    ] as [string, unknown[]];
  };

  const insertTransaction = (over: Record<string, unknown> = {}) => {
    const row = {
      id: randomUUID(),
      external_transaction_id: `ext-${randomUUID()}`,
      idempotency_key: `key-${randomUUID()}`,
      kind: 'LOSS',
      status: 'PENDING',
      processed_at: null,
      reference_external_transaction_id: null,
      reference_transaction_id: null,
      ...over,
    };
    return [
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
          status, reference_transaction_id, processed_at, created_at)
       values (?, 'provider-a', ?, ?, 'hash', ?, ?, 'round', 'game', ?, 1.00, 'BRL', ?, ?, ?, ?, now())`,
      [
        row.id,
        row.external_transaction_id,
        row.idempotency_key,
        wallet.id,
        wallet.playerId,
        row.kind,
        row.reference_external_transaction_id,
        row.status,
        row.reference_transaction_id,
        row.processed_at,
      ],
    ] as [string, unknown[]];
  };

  describe('wallets', () => {
    it('refuse a negative balance', async () => {
      await expectRefused(
        'update wallets set balance = -0.01 where id = ?',
        [wallet.id],
        /wallets_balance_non_negative/,
      );
    });

    it('allow one wallet per player and currency', async () => {
      await expectRefused(
        `insert into wallets values (?, ?, 'BRL', 0, 1, now(), now())`,
        [randomUUID(), wallet.playerId],
        /wallets_player_currency_unique/,
      );
    });

    it('refuse a balance change that has no ledger entry', async () => {
      await expectRefused(
        'update wallets set balance = balance + 50, version = version + 1 where id = ?',
        [wallet.id],
        /does not match its ledger/,
      );
    });
  });

  describe('wallet_ledger_entries', () => {
    it('are append-only: update, delete and truncate are refused', async () => {
      await expectRefused(
        'update wallet_ledger_entries set amount = 1.00',
        [],
        /UPDATE .* append-only/,
      );
      await expectRefused(
        'delete from wallet_ledger_entries',
        [],
        /DELETE .* append-only/,
      );
      await expectRefused(
        'truncate wallet_ledger_entries',
        [],
        /TRUNCATE .* append-only/,
      );
    });

    it('must be arithmetically balanced', async () => {
      const loss = await app.submit.execute(
        operation(wallet, { kind: Kind.Loss }),
      );
      await expectRefused(
        ...insertEntry({
          transaction_id: loss.transactionId,
          balance_after: '60.00',
        }),
        /wallet_ledger_entries_balanced/,
      );
    });

    it('must continue the previous balance of the wallet', async () => {
      const loss = await app.submit.execute(
        operation(wallet, { kind: Kind.Loss }),
      );
      await expectRefused(
        ...insertEntry({
          transaction_id: loss.transactionId,
          balance_before: '99.00',
          balance_after: '89.00',
        }),
        /ledger chain broken/,
      );
    });

    it('must use the currency of the wallet', async () => {
      const loss = await app.submit.execute(
        operation(wallet, { kind: Kind.Loss }),
      );
      await expectRefused(
        ...insertEntry({ transaction_id: loss.transactionId, currency: 'USD' }),
        /currency USD differs from wallet currency BRL/,
      );
    });

    it('allow at most one entry per wallet and transaction', async () => {
      await expectRefused(
        ...insertEntry(),
        /wallet_ledger_entries_one_per_wallet_transaction/,
      );
    });

    it('refuse an entry whose wallet balance was not updated', async () => {
      const loss = await app.submit.execute(
        operation(wallet, { kind: Kind.Loss }),
      );
      const [sql, params] = insertEntry({ transaction_id: loss.transactionId });

      await expect(
        db.orm.em.fork().transactional((tx) => tx.execute(sql, [...params])),
      ).rejects.toThrow(/does not match its ledger/);

      const [row] = await db.query<{ entries: string }>(
        'select count(*) as entries from wallet_ledger_entries where wallet_id = ?',
        [wallet.id],
      );
      expect(Number(row.entries)).toBe(2);
    });
  });

  describe('wager_transactions', () => {
    it('are unique by idempotency key', async () => {
      const [{ idempotency_key }] = await db.query<{ idempotency_key: string }>(
        'select idempotency_key from wager_transactions where id = ?',
        [bet.transactionId],
      );
      await expectRefused(
        ...insertTransaction({ idempotency_key }),
        /wager_transactions_idempotency_key_unique/,
      );
    });

    it('are unique by provider and provider transaction id', async () => {
      await expectRefused(
        ...insertTransaction({
          external_transaction_id: bet.externalTransactionId,
        }),
        /wager_transactions_provider_external_unique/,
      );
    });

    it('cannot change once terminal, and cannot be deleted', async () => {
      await expectRefused(
        `update wager_transactions set status = 'FAILED', failure_code = 'INTERNAL_ERROR' where id = ?`,
        [bet.transactionId],
        /is terminal/,
      );
      await expectRefused(
        'delete from wager_transactions where id = ?',
        [bet.transactionId],
        /DELETE .* append-only/,
      );
    });

    describe('while pending a reference', () => {
      let pendingId: string;

      beforeEach(async () => {
        const pending = await app.submit.execute(
          operation(wallet, {
            kind: Kind.Refund,
            referenceExternalTransactionId: 'not-there-yet',
          }),
        );
        pendingId = pending.transactionId;
      });

      it('keep their identifying columns immutable', async () => {
        await expectRefused(
          'update wager_transactions set amount = 1.00 where id = ?',
          [pendingId],
          /immutable columns/,
        );
      });

      it('need a failure code to be rejected', async () => {
        await expectRefused(
          `update wager_transactions
              set status = 'REJECTED', next_reference_attempt_at = null where id = ?`,
          [pendingId],
          /wager_transactions_failure_code_matches_status/,
        );
      });

      it('need a processing time to be processed', async () => {
        await expectRefused(
          `update wager_transactions
              set status = 'PROCESSED', next_reference_attempt_at = null where id = ?`,
          [pendingId],
          /wager_transactions_processed_at_matches_status/,
        );
      });
    });

    it('allow a reference to be reverted only once per kind', async () => {
      const revert = (kind: string) =>
        insertTransaction({
          kind,
          status: 'PROCESSED',
          processed_at: new Date(),
          reference_external_transaction_id: bet.externalTransactionId,
          reference_transaction_id: bet.transactionId,
        });

      await db.query(...revert('REFUND'));
      await expectRefused(
        ...revert('REFUND'),
        /wager_transactions_reversal_unique/,
      );
      await db.query(...revert('ROLLBACK'));
    });

    it('require a reference for REFUND and ROLLBACK', async () => {
      await expectRefused(
        ...insertTransaction({ kind: 'REFUND' }),
        /wager_transactions_reversal_needs_reference/,
      );
    });
  });

  it('keeps the money the use cases moved consistent', async () => {
    await app.submit.execute(operation(wallet, { money: money('10.00') }));
    const result = await app.reconcile.execute(wallet.id);
    expect(result).toMatchObject({ consistent: true, checkedEntries: 3 });
  });
});
