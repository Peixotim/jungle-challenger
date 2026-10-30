import { Wallet } from '../../../domain/wallet/model/Wallet.js';
import { toDate, toMoney } from './columns.js';

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export const WALLET_COLUMNS =
  'id, player_id, currency, balance, version, created_at, updated_at';

export function toWallet(row: WalletRow): Wallet {
  const currency = row.currency.trim();
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency,
    balance: toMoney(row.balance, currency),
    version: Number(row.version),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}
