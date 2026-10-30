import { InvalidTransactionError } from '../../errors/domain-errors.js';
import { MoneyProps } from '../../money/dtos/MoneyProps.js';
import { WagerTransactionKind } from '../../wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../wagering/enums/WagerTransactionStatus.js';
import { WagerTransaction } from '../../wagering/model/WagerTransaction.js';
import { EventContext } from '../dtos/EventContext.js';
import { IntegrationEvent } from './IntegrationEvent.js';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      !tx.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionError(
        `transaction ${tx.id} is not PENDING_REFERENCE`,
      );
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        kind: tx.kind,
        money: tx.money.toJSON(),
      },
    });
  }
}
