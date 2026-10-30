import { Clock } from '../../../src/application/ports/Clock.js';
import { IdGenerator } from '../../../src/application/ports/IdGenerator.js';
import { InboxRepository } from '../../../src/application/ports/InboxRepository.js';
import { EventPublisher } from '../../../src/application/ports/EventPublisher.js';
import {
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
} from '../../../src/application/ports/LedgerRepository.js';
import { LogFields, Logger } from '../../../src/application/ports/Logger.js';
import {
  MetricLabels,
  Metrics,
} from '../../../src/application/ports/Metrics.js';
import { OutboxRepository } from '../../../src/application/ports/OutboxRepository.js';
import {
  TransactionalContext,
  UnitOfWork,
} from '../../../src/application/ports/UnitOfWork.js';
import {
  InsertIfAbsentResult,
  WagerTransactionRepository,
} from '../../../src/application/ports/WagerTransactionRepository.js';
import { WalletRepository } from '../../../src/application/ports/WalletRepository.js';
import { LedgerDirection } from '../../../src/domain/ledger/enums/LedgerDirection.js';
import { WalletLedgerEntry } from '../../../src/domain/ledger/model/WalletLedgerEntry.js';
import { InboxMessage } from '../../../src/domain/messaging/model/InboxMessage.js';
import { OutboxMessage } from '../../../src/domain/messaging/model/OutboxMessage.js';
import { Money } from '../../../src/domain/money/model/Money.js';
import { WagerTransactionKind } from '../../../src/domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { WagerTransaction } from '../../../src/domain/wagering/model/WagerTransaction.js';
import { Wallet } from '../../../src/domain/wallet/model/Wallet.js';

export class InMemoryDatabase {
  readonly wallets = new Map<string, Wallet>();
  readonly transactions = new Map<string, WagerTransaction>();
  readonly ledger: WalletLedgerEntry[] = [];
  readonly inbox = new Map<string, InboxMessage>();
  readonly outbox: OutboxMessage[] = [];

  readonly uow: UnitOfWork = new InMemoryUnitOfWork(this);

  seedWallet(balance: string, id = 'w1', playerId = 'p1'): Wallet {
    const { wallet, openingEntry } = Wallet.open({
      id,
      playerId,
      initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
      now: new Date('2026-01-01T00:00:00Z'),
      opening: { entryId: `opening-${id}`, transactionId: `opening-tx-${id}` },
    });
    this.wallets.set(id, wallet);
    if (openingEntry) this.ledger.push(openingEntry);
    return wallet;
  }

  ledgerBalance(walletId: string): Money {
    return this.ledger
      .filter((e) => e.walletId === walletId)
      .reduce(
        (sum, e) =>
          e.direction === LedgerDirection.Credit
            ? sum.add(e.money)
            : sum.subtract(e.money),
        Money.zero('BRL'),
      );
  }

  eventTypes(): string[] {
    return this.outbox.map((m) => m.eventType);
  }
}

class InMemoryUnitOfWork extends UnitOfWork {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ctx: TransactionalContext;

  constructor(db: InMemoryDatabase) {
    super();
    this.ctx = {
      wallets: new InMemoryWallets(db),
      transactions: new InMemoryTransactions(db),
      ledger: new InMemoryLedger(db),
      inbox: new InMemoryInbox(db),
      outbox: new InMemoryOutbox(db),
    };
  }

  run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    const result = this.tail.then(() => work(this.ctx));
    this.tail = result.catch(() => undefined);
    return result;
  }
}

class InMemoryWallets extends WalletRepository {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  findById(id: string): Promise<Wallet | undefined> {
    return Promise.resolve(this.db.wallets.get(id));
  }

  findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    return Promise.resolve(this.db.wallets.get(id));
  }

  insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const taken = [...this.db.wallets.values()].some(
      (w) => w.playerId === wallet.playerId && w.currency === wallet.currency,
    );
    if (taken) return Promise.resolve(false);
    this.db.wallets.set(wallet.id, wallet);
    return Promise.resolve(true);
  }

  save(wallet: Wallet): Promise<void> {
    this.db.wallets.set(wallet.id, wallet);
    return Promise.resolve();
  }
}

class InMemoryTransactions extends WagerTransactionRepository {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  insertIfAbsent(candidate: WagerTransaction): Promise<InsertIfAbsentResult> {
    const all = [...this.db.transactions.values()];
    const existing =
      all.find((t) => t.idempotencyKey === candidate.idempotencyKey) ??
      all.find(
        (t) =>
          t.providerId === candidate.providerId &&
          t.externalTransactionId === candidate.externalTransactionId,
      );
    if (existing)
      return Promise.resolve({ transaction: existing, inserted: false });
    this.db.transactions.set(candidate.id, candidate);
    return Promise.resolve({ transaction: candidate, inserted: true });
  }

  save(transaction: WagerTransaction): Promise<void> {
    this.db.transactions.set(transaction.id, transaction);
    return Promise.resolve();
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return Promise.resolve(this.db.transactions.get(id));
  }

  claimNextDueForReference(now: Date): Promise<WagerTransaction | undefined> {
    const due = [...this.db.transactions.values()]
      .filter((t) => t.isReferenceRetryDue(now))
      .sort(
        (a, b) =>
          a.nextReferenceAttemptAt!.getTime() -
          b.nextReferenceAttemptAt!.getTime(),
      );
    return Promise.resolve(due[0]);
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return Promise.resolve(
      [...this.db.transactions.values()].find(
        (t) =>
          t.providerId === providerId &&
          t.externalTransactionId === externalTransactionId,
      ),
    );
  }

  hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    return Promise.resolve(
      [...this.db.transactions.values()].some(
        (t) =>
          t.referenceTransactionId === referenceTransactionId &&
          t.kind === kind &&
          t.status === WagerTransactionStatus.Processed,
      ),
    );
  }
}

class InMemoryLedger extends LedgerRepository {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  append(entry: WalletLedgerEntry): Promise<void> {
    this.db.ledger.push(entry);
    return Promise.resolve();
  }

  listByWallet(
    walletId: string,
    page: { after?: string; limit: number },
  ): Promise<LedgerPage> {
    const all = this.db.ledger.filter((e) => e.walletId === walletId);
    const start = page.after === undefined ? 0 : Number(page.after) + 1;
    const entries = all.slice(start, start + page.limit);
    const last = start + entries.length - 1;
    const nextCursor = last < all.length - 1 ? String(last) : undefined;
    return Promise.resolve({ entries, nextCursor });
  }

  summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const entries = this.db.ledger.filter((e) => e.walletId === walletId);
    const balance = entries.reduce(
      (sum, e) =>
        e.direction === LedgerDirection.Credit
          ? sum.add(e.money)
          : sum.subtract(e.money),
      Money.zero(currency),
    );
    return Promise.resolve({ balance, entries: entries.length });
  }
}

class InMemoryInbox extends InboxRepository {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  receiveIfAbsent(message: InboxMessage): Promise<boolean> {
    const key = `${message.consumerName}:${message.messageId}`;
    if (this.db.inbox.has(key)) return Promise.resolve(false);
    this.db.inbox.set(key, message);
    return Promise.resolve(true);
  }

  markProcessed(): Promise<void> {
    return Promise.resolve();
  }
}

class InMemoryOutbox extends OutboxRepository {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  enqueue(message: OutboxMessage): Promise<void> {
    this.db.outbox.push(message);
    return Promise.resolve();
  }

  claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    return Promise.resolve(
      this.db.outbox
        .filter((m) => m.isDue(now))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .slice(0, limit),
    );
  }

  save(): Promise<void> {
    return Promise.resolve();
  }
}

export class FixedClock extends Clock {
  constructor(private current = new Date('2026-01-01T12:00:00Z')) {
    super();
  }

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class RecordingMetrics extends Metrics {
  readonly counters: { name: string; labels?: MetricLabels }[] = [];
  readonly observations: { name: string; value: number }[] = [];

  increment(name: string, labels?: MetricLabels): void {
    this.counters.push({ name, labels });
  }

  observe(name: string, value: number): void {
    this.observations.push({ name, value });
  }

  count(name: string): number {
    return this.counters.filter((c) => c.name === name).length;
  }
}

export class RecordingLogger extends Logger {
  readonly entries: { level: string; message: string; fields?: LogFields }[] =
    [];

  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'debug', message, fields });
  }

  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields });
  }

  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields });
  }

  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields });
  }
}

export class FakePublisher extends EventPublisher {
  readonly published: OutboxMessage[] = [];
  private failures = 0;

  failNext(times: number): void {
    this.failures = times;
  }

  publish(message: OutboxMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('broker unavailable'));
    }
    this.published.push(message);
    return Promise.resolve();
  }
}

export class SequentialIds extends IdGenerator {
  private n = 0;

  next(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
}
