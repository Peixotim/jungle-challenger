import { WagerTransactionView } from '../dtos/WagerTransactionView.js';
import { TransactionNotFoundError } from '../errors/application-errors.js';
import { toWagerTransactionView } from '../mappers/views.js';
import { UnitOfWork } from '../ports/UnitOfWork.js';

export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  byId(transactionId: string): Promise<WagerTransactionView> {
    return this.uow.run(async (ctx) => {
      const tx = await ctx.transactions.findById(transactionId);
      if (!tx) {
        throw new TransactionNotFoundError(
          `transaction ${transactionId} not found`,
        );
      }
      return toWagerTransactionView(tx);
    });
  }

  byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.uow.run(async (ctx) => {
      const tx = await ctx.transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      if (!tx) {
        throw new TransactionNotFoundError(
          `transaction ${externalTransactionId} of provider ${providerId} not found`,
        );
      }
      return toWagerTransactionView(tx);
    });
  }
}
