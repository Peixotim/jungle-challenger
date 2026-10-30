import type { EntityManager } from '@mikro-orm/postgresql';
import {
  TransactionalContext,
  UnitOfWork,
} from '../../application/ports/UnitOfWork.js';
import { PgInboxRepository } from './repositories/PgInboxRepository.js';
import { PgLedgerRepository } from './repositories/PgLedgerRepository.js';
import { PgOutboxRepository } from './repositories/PgOutboxRepository.js';
import { PgWagerTransactionRepository } from './repositories/PgWagerTransactionRepository.js';
import { PgWalletRepository } from './repositories/PgWalletRepository.js';

export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly em: EntityManager) {
    super();
  }

  run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.em
      .fork()
      .transactional((tx) => work(contextFor(tx as EntityManager)));
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
