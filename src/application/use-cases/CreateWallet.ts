import { WagerTransactionProcessed } from '../../domain/events/model/WagerTransactionProcessed.js';
import { WalletBalanceChanged } from '../../domain/events/model/WalletBalanceChanged.js';
import { OutboxMessage } from '../../domain/messaging/model/OutboxMessage.js';
import { Money } from '../../domain/money/model/Money.js';
import { WagerTransactionKind } from '../../domain/wagering/enums/WagerTransactionKind.js';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
} from '../../domain/wagering/model/WagerTransaction.js';
import { Wallet } from '../../domain/wallet/model/Wallet.js';
import { CreateWalletCommand } from '../dtos/CreateWalletCommand.js';
import { WalletView } from '../dtos/WalletView.js';
import { WalletAlreadyExistsError } from '../errors/application-errors.js';
import { computePayloadHash } from '../idempotency/payload-hash.js';
import { toWalletView } from '../mappers/views.js';
import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { UnitOfWork } from '../ports/UnitOfWork.js';

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance,
      now,
      opening: {
        entryId: this.ids.next(),
        transactionId: openingTransactionId,
      },
    });

    return this.uow.run(async (ctx) => {
      if (!(await ctx.wallets.insertIfAbsent(wallet))) {
        throw new WalletAlreadyExistsError(cmd.playerId, wallet.currency);
      }

      if (openingEntry) {
        const opening = WagerTransaction.opening({
          id: openingTransactionId,
          walletId,
          playerId: cmd.playerId,
          money: initialBalance,
          payloadHash: computePayloadHash({
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: `opening:${walletId}`,
            playerId: cmd.playerId,
            walletId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
          }),
          createdAt: now,
        });
        opening.markProcessed(undefined, now, wallet.balance);
        await ctx.transactions.insertIfAbsent(opening);
        await ctx.ledger.append(openingEntry);

        const event = () => ({
          eventId: this.ids.next(),
          correlationId: cmd.correlationId,
          occurredAt: now,
        });
        await ctx.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, event()),
          ),
        );
        await ctx.outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(opening, event()),
          ),
        );
      }

      return toWalletView(wallet);
    });
  }
}
