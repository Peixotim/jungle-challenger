import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../../application/ports/WalletRepository.js';
import { Wallet } from '../../../domain/wallet/model/Wallet.js';
import { OptimisticLockError } from '../errors.js';
import { isUuid } from '../mappers/columns.js';
import {
  toWallet,
  WALLET_COLUMNS,
  WalletRow,
} from '../mappers/WalletMapper.js';

export class PgWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<Wallet | undefined> {
    return this.select(id, '');
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    return this.select(id, ' for update');
  }

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const rows = await this.em.execute<{ id: string }[]>(
      `insert into wallets (${WALLET_COLUMNS})
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    return rows.length === 1;
  }

  async save(wallet: Wallet): Promise<void> {
    const rows = await this.em.execute<{ id: string }[]>(
      `update wallets
          set balance = ?, version = ?, updated_at = ?
        where id = ? and version = ?
        returning id`,
      [
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        wallet.version - 1,
      ],
    );
    if (rows.length !== 1) throw new OptimisticLockError('wallet', wallet.id);
  }

  private async select(
    id: string,
    lock: '' | ' for update',
  ): Promise<Wallet | undefined> {
    if (!isUuid(id)) return undefined;
    const rows = await this.em.execute<WalletRow[]>(
      `select ${WALLET_COLUMNS} from wallets where id = ?${lock}`,
      [id],
    );
    return rows[0] ? toWallet(rows[0]) : undefined;
  }
}
