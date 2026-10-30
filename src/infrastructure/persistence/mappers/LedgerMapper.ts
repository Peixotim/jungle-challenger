import { LedgerDirection } from '../../../domain/ledger/enums/LedgerDirection.js';
import { WalletLedgerEntry } from '../../../domain/ledger/model/WalletLedgerEntry.js';
import { toDate, toMoney } from './columns.js';

export interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

export const LEDGER_COLUMNS =
  'seq, id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at';

export function toLedgerEntry(row: LedgerRow): WalletLedgerEntry {
  const currency = row.currency.trim();
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction,
    money: toMoney(row.amount, currency),
    balanceBefore: toMoney(row.balance_before, currency),
    balanceAfter: toMoney(row.balance_after, currency),
    createdAt: toDate(row.created_at),
  });
}
