import { EventContext } from '../../domain/events/dtos/EventContext.js';
import { IntegrationEvent } from '../../domain/events/model/IntegrationEvent.js';
import { WagerTransactionPendingReference } from '../../domain/events/model/WagerTransactionPendingReference.js';
import { WagerTransactionProcessed } from '../../domain/events/model/WagerTransactionProcessed.js';
import { WagerTransactionRejected } from '../../domain/events/model/WagerTransactionRejected.js';
import { WalletBalanceChanged } from '../../domain/events/model/WalletBalanceChanged.js';
import { InsufficientFundsError } from '../../domain/errors/domain-errors.js';
import { LedgerDirection } from '../../domain/ledger/enums/LedgerDirection.js';
import { WalletLedgerEntry } from '../../domain/ledger/model/WalletLedgerEntry.js';
import { OutboxMessage } from '../../domain/messaging/model/OutboxMessage.js';
import { Money } from '../../domain/money/model/Money.js';
import { FailureCode } from '../../domain/wagering/enums/FailureCode.js';
import { WagerTransactionStatus } from '../../domain/wagering/enums/WagerTransactionStatus.js';
import { WagerTransaction } from '../../domain/wagering/model/WagerTransaction.js';
import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { TransactionalContext } from '../ports/UnitOfWork.js';

export const DEFAULT_MAX_REFERENCE_ATTEMPTS = 10;

export interface ProcessingMeta {
  correlationId: string;
  causationId?: string;
}

export class WagerTransactionProcessor {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly maxReferenceAttempts = DEFAULT_MAX_REFERENCE_ATTEMPTS,
  ) {}

  async process(
    ctx: TransactionalContext,
    tx: WagerTransaction,
    meta: ProcessingMeta,
  ): Promise<void> {
    const now = this.clock.now();
    const event = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: meta.correlationId,
      causationId: meta.causationId,
      occurredAt: now,
    });
    const emit = (e: IntegrationEvent<unknown>) =>
      ctx.outbox.enqueue(OutboxMessage.enqueue(e));
    const reject = async (code: FailureCode, balance?: Money) => {
      tx.reject(code, balance);
      await ctx.transactions.save(tx);
      await emit(WagerTransactionRejected.from(tx, event()));
    };

    const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) return reject(FailureCode.WalletNotFound);
    if (wallet.playerId !== tx.playerId) {
      return reject(FailureCode.WalletPlayerMismatch, wallet.balance);
    }
    if (wallet.currency !== tx.money.currency) {
      return reject(FailureCode.CurrencyMismatch, wallet.balance);
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      reference = await ctx.transactions.findByProviderAndExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (!reference || !reference.isTerminal()) {
        if (tx.status === WagerTransactionStatus.Pending) {
          tx.markPendingReference(now);
          await ctx.transactions.save(tx);
          await emit(WagerTransactionPendingReference.from(tx, event()));
        } else if (tx.referenceAttempts + 1 >= this.maxReferenceAttempts) {
          await reject(FailureCode.ReferenceNotFound, wallet.balance);
        } else {
          tx.scheduleReferenceRetry(now);
          await ctx.transactions.save(tx);
        }
        return;
      }
      const invalid = tx.checkReference(reference);
      if (invalid) return reject(invalid, wallet.balance);

      if (
        tx.requiresReference() &&
        (await ctx.transactions.hasProcessedReversal(reference.id, tx.kind))
      ) {
        return reject(FailureCode.AlreadyReversed, wallet.balance);
      }
    }

    let entry: WalletLedgerEntry | undefined;
    if (tx.affectsBalance()) {
      const movement = {
        entryId: this.ids.next(),
        transactionId: tx.id,
        money: tx.money,
        at: now,
      };
      try {
        entry =
          tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
            ? wallet.debit(movement)
            : wallet.credit(movement);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          return reject(tx.overdrawFailureCode(), wallet.balance);
        }
        throw error;
      }
    }

    tx.markProcessed(reference?.id, now, wallet.balance);
    await ctx.transactions.save(tx);
    if (entry) {
      await ctx.wallets.save(wallet);
      await ctx.ledger.append(entry);
      await emit(WalletBalanceChanged.from(wallet, entry, event()));
    }
    await emit(WagerTransactionProcessed.from(tx, event()));
  }
}
