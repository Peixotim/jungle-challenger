import { ReconciliationResult } from '../dtos/ReconciliationResult.js';
import { WalletNotFoundError } from '../errors/application-errors.js';
import { Logger } from '../ports/Logger.js';
import { Metrics } from '../ports/Metrics.js';
import { UnitOfWork } from '../ports/UnitOfWork.js';

export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    return this.uow.run(async (ctx) => {
      const wallet = await ctx.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const { balance: calculated, entries } = await ctx.ledger.summarize(
        walletId,
        wallet.currency,
      );
      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero();

      this.metrics.increment('wallet_reconciliations_total', {
        result: consistent ? 'consistent' : 'divergent',
      });
      if (!consistent) {
        this.logger.error('wallet balance diverges from ledger', {
          walletId,
          storedBalance: wallet.balance.toString(),
          calculatedBalance: calculated.toString(),
          difference: difference.toString(),
        });
      }

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries,
      };
    });
  }
}
