import { MoneyProps } from '../../domain/money/dtos/MoneyProps.js';
import { WagerTransactionKind } from '../../domain/wagering/enums/WagerTransactionKind.js';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  source?: { consumerName: string; messageId: string };
}
