import { Money } from '../../money/model/Money.js';
import { FailureCode } from '../enums/FailureCode.js';
import { WagerTransactionStatus } from '../enums/WagerTransactionStatus.js';
import { CreateWagerTransactionProps } from './CreateWagerTransactionProps.js';

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}
