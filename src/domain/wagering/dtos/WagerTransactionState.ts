import { FailureCode } from '../enums/FailureCode.js';
import { WagerTransactionStatus } from '../enums/WagerTransactionStatus.js';
import { CreateWagerTransactionProps } from './CreateWagerTransactionProps.js';

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  /** internal id of the resolved reference */
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** retries made while PENDING_REFERENCE */
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}
