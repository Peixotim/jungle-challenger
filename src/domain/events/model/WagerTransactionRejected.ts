import { InvalidTransactionError } from '../../errors/domain-errors.js';
import { MoneyProps } from '../../money/dtos/MoneyProps.js';
import { FailureCode } from '../../wagering/enums/FailureCode.js';
import { WagerTransactionKind } from '../../wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../wagering/enums/WagerTransactionStatus.js';
import { WagerTransaction } from '../../wagering/model/WagerTransaction.js';
import { EventContext } from '../dtos/EventContext.js';
import { IntegrationEvent } from './IntegrationEvent.js';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (tx.status !== WagerTransactionStatus.Rejected || !tx.failureCode) {
      throw new InvalidTransactionError(`transaction ${tx.id} is not REJECTED`);
    }
    return new WagerTransactionRejected({
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
        failureCode: tx.failureCode,
      },
    });
  }
}
