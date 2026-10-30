import { Money } from '../../money/model/Money.js';
import { LedgerDirection } from '../enums/LedgerDirection.js';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}
