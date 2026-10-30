import { WalletLedgerEntry } from '../../domain/ledger/model/WalletLedgerEntry.js';
import { Money } from '../../domain/money/model/Money.js';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerSummary {
  balance: Money;
  entries: number;
}

export abstract class LedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;

  abstract listByWallet(
    walletId: string,
    page: { after?: string; limit: number },
  ): Promise<LedgerPage>;

  abstract summarize(
    walletId: string,
    currency: string,
  ): Promise<LedgerSummary>;
}
