import type { EntityManager } from '@mikro-orm/postgresql';
import { InvalidQueryError } from '../../../application/errors/application-errors.js';
import {
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
} from '../../../application/ports/LedgerRepository.js';
import { WalletLedgerEntry } from '../../../domain/ledger/model/WalletLedgerEntry.js';
import { Money } from '../../../domain/money/model/Money.js';
import { isUuid, toMoney } from '../mappers/columns.js';
import {
  LEDGER_COLUMNS,
  LedgerRow,
  toLedgerEntry,
} from '../mappers/LedgerMapper.js';

export class PgLedgerRepository extends LedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency,
          balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toJSON().amount,
        entry.money.currency,
        entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount,
        entry.createdAt,
      ],
    );
  }

  async listByWallet(
    walletId: string,
    page: { after?: string; limit: number },
  ): Promise<LedgerPage> {
    if (!isUuid(walletId)) return { entries: [] };
    const after = page.after === undefined ? 0n : decodeCursor(page.after);

    const rows = await this.em.execute<LedgerRow[]>(
      `select ${LEDGER_COLUMNS} from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq
        limit ?`,
      [walletId, after.toString(), page.limit + 1],
    );

    const hasMore = rows.length > page.limit;
    const visible = hasMore ? rows.slice(0, page.limit) : rows;
    return {
      entries: visible.map(toLedgerEntry),
      nextCursor: hasMore
        ? encodeCursor(visible[visible.length - 1].seq)
        : undefined,
    };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<
      { credits: string | null; debits: string | null; entries: string }[]
    >(
      `select sum(amount) filter (where direction = 'CREDIT') as credits,
              sum(amount) filter (where direction = 'DEBIT') as debits,
              count(*) as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const sum = (value: string | null): Money =>
      value === null ? Money.zero(currency) : toMoney(value, currency);
    return {
      balance: sum(row.credits).subtract(sum(row.debits)),
      entries: Number(row.entries),
    };
  }
}

function encodeCursor(seq: string): string {
  return Buffer.from(seq, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): bigint {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) throw new InvalidQueryError('invalid cursor');
  return BigInt(decoded);
}
