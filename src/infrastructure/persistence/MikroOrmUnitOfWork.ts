import type { EntityManager } from '@mikro-orm/postgresql';
import { Metrics } from '../../application/ports/Metrics.js';
import {
  TransactionalContext,
  UnitOfWork,
} from '../../application/ports/UnitOfWork.js';
import { PgInboxRepository } from './repositories/PgInboxRepository.js';
import { PgLedgerRepository } from './repositories/PgLedgerRepository.js';
import { PgOutboxRepository } from './repositories/PgOutboxRepository.js';
import { PgWagerTransactionRepository } from './repositories/PgWagerTransactionRepository.js';
import { PgWalletRepository } from './repositories/PgWalletRepository.js';
import { classifyTransient } from './transient-errors.js';

export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics?: Metrics,
  ) {
    super();
  }

  async run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    try {
      return await this.em
        .fork()
        .transactional((tx) => work(contextFor(tx as EntityManager)));
    } catch (error) {
      const kind = classifyTransient(error);
      if (kind) this.metrics?.increment('db_transient_errors_total', { kind });
      if (kind === 'lock_conflict') {
        this.metrics?.increment('db_lock_conflicts_total');
      }
      throw error;
    }
  }
}

function contextFor(em: EntityManager): TransactionalContext {
  return {
    wallets: new PgWalletRepository(em),
    transactions: new PgWagerTransactionRepository(em),
    ledger: new PgLedgerRepository(em),
    inbox: new PgInboxRepository(em),
    outbox: new PgOutboxRepository(em),
  };
}
