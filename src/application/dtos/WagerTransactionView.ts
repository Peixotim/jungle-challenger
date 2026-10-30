import { MoneyProps } from '../../domain/money/dtos/MoneyProps.js';
import { FailureCode } from '../../domain/wagering/enums/FailureCode.js';
import { WagerTransactionKind } from '../../domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../domain/wagering/enums/WagerTransactionStatus.js';

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}
