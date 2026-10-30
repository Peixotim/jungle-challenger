import { Money } from '../../money/model/Money.js';

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}
