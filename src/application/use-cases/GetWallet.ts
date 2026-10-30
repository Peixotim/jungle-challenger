import { WalletView } from '../dtos/WalletView.js';
import { WalletNotFoundError } from '../errors/application-errors.js';
import { toWalletView } from '../mappers/views.js';
import { UnitOfWork } from '../ports/UnitOfWork.js';

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    return this.uow.run(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return toWalletView(wallet);
    });
  }
}
