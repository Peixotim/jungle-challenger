import { LedgerDirection } from '../../domain/ledger/enums/LedgerDirection.js';
import { MoneyProps } from '../../domain/money/dtos/MoneyProps.js';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  entries: LedgerEntryView[];
  nextCursor?: string;
}
