import { WalletLedgerEntry } from '../../ledger/model/WalletLedgerEntry.js';
import { Money } from '../../money/model/Money.js';
import { Wallet } from '../model/Wallet.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
  opening?: { entryId: string; transactionId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}
