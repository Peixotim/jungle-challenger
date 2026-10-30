import { LedgerPageView } from '../dtos/LedgerPageView.js';
import {
  InvalidQueryError,
  WalletNotFoundError,
} from '../errors/application-errors.js';
import { toLedgerEntryView } from '../mappers/views.js';
import { UnitOfWork } from '../ports/UnitOfWork.js';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 200;

export class GetWalletLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(
    walletId: string,
    page: { cursor?: string; limit?: number } = {},
  ): Promise<LedgerPageView> {
    const limit = page.limit ?? DEFAULT_LEDGER_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE_SIZE) {
      throw new InvalidQueryError(
        `limit must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}`,
      );
    }

    return this.uow.run(async (ctx) => {
      if (!(await ctx.wallets.findById(walletId))) {
        throw new WalletNotFoundError(walletId);
      }
      const { entries, nextCursor } = await ctx.ledger.listByWallet(walletId, {
        after: page.cursor,
        limit,
      });
      return { entries: entries.map(toLedgerEntryView), nextCursor };
    });
  }
}
