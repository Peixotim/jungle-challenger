import { InvalidTransactionError } from '../../errors/domain-errors.js';
import { MoneyProps } from '../../money/dtos/MoneyProps.js';
import { WagerTransactionKind } from '../../wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../wagering/enums/WagerTransactionStatus.js';
import { WagerTransaction } from '../../wagering/model/WagerTransaction.js';
import { EventContext } from '../dtos/EventContext.js';
import { IntegrationEvent } from './IntegrationEvent.js';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed || !tx.processedAt) {
      throw new InvalidTransactionError(
        `transaction ${tx.id} is not PROCESSED`,
      );
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}
