import { MoneyProps } from '../../domain/money/dtos/MoneyProps.js';
import { FailureCode } from '../../domain/wagering/enums/FailureCode.js';
import { WagerTransactionStatus } from '../../domain/wagering/enums/WagerTransactionStatus.js';

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}
