import { InboxRepository } from './InboxRepository.js';
import { LedgerRepository } from './LedgerRepository.js';
import { OutboxRepository } from './OutboxRepository.js';
import { WagerTransactionRepository } from './WagerTransactionRepository.js';
import { WalletRepository } from './WalletRepository.js';

export interface TransactionalContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export abstract class UnitOfWork {
  abstract run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}
