import type { EntityManager } from '@mikro-orm/postgresql';
import {
  InsertIfAbsentResult,
  WagerTransactionRepository,
} from '../../../application/ports/WagerTransactionRepository.js';
import { WagerTransactionKind } from '../../../domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransaction } from '../../../domain/wagering/model/WagerTransaction.js';
import { isUuid } from '../mappers/columns.js';
import {
  toTransaction,
  TRANSACTION_COLUMNS,
  TransactionRow,
} from '../mappers/TransactionMapper.js';

export class PgWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insertIfAbsent(
    candidate: WagerTransaction,
  ): Promise<InsertIfAbsentResult> {
    const inserted = await this.em.execute<{ id: string }[]>(
      `insert into wager_transactions (${TRANSACTION_COLUMNS})
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      this.insertParams(candidate),
    );
    if (inserted.length === 1)
      return { transaction: candidate, inserted: true };

    const existing =
      (await this.selectOne('idempotency_key = ?', [
        candidate.idempotencyKey,
      ])) ??
      (await this.selectOne('provider_id = ? and external_transaction_id = ?', [
        candidate.providerId,
        candidate.externalTransactionId,
      ]));
    if (!existing) {
      throw new Error(
        `transaction ${candidate.id} conflicted but no existing row was found`,
      );
    }
    return { transaction: existing, inserted: false };
  }

  async save(tx: WagerTransaction): Promise<void> {
    await this.em.execute(
      `update wager_transactions
          set status = ?, reference_transaction_id = ?, failure_code = ?, processed_at = ?,
              observed_balance = ?, reference_attempts = ?, next_reference_attempt_at = ?
        where id = ?`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.processedAt ?? null,
        tx.observedBalance?.toJSON().amount ?? null,
        tx.referenceAttempts,
        tx.nextReferenceAttemptAt ?? null,
        tx.id,
      ],
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    return this.selectOne('id = ?', [id]);
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.selectOne('provider_id = ? and external_transaction_id = ?', [
      providerId,
      externalTransactionId,
    ]);
  }

  async hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    const rows = await this.em.execute<unknown[]>(
      `select 1 from wager_transactions
        where reference_transaction_id = ? and kind = ? and status = 'PROCESSED'
        limit 1`,
      [referenceTransactionId, kind],
    );
    return rows.length > 0;
  }

  async claimNextDueForReference(
    now: Date,
  ): Promise<WagerTransaction | undefined> {
    return this.selectOne(
      `status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
       order by next_reference_attempt_at
       limit 1
       for update skip locked`,
      [now],
    );
  }

  private async selectOne(
    where: string,
    params: unknown[],
  ): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<TransactionRow[]>(
      `select ${TRANSACTION_COLUMNS} from wager_transactions where ${where}`,
      params,
    );
    return rows[0] ? toTransaction(rows[0]) : undefined;
  }

  private insertParams(tx: WagerTransaction): unknown[] {
    return [
      tx.id,
      tx.providerId,
      tx.externalTransactionId,
      tx.idempotencyKey,
      tx.payloadHash,
      tx.walletId,
      tx.playerId,
      tx.roundId,
      tx.gameId,
      tx.kind,
      tx.money.toJSON().amount,
      tx.money.currency,
      tx.referenceExternalTransactionId ?? null,
      tx.status,
      tx.referenceTransactionId ?? null,
      tx.failureCode ?? null,
      tx.processedAt ?? null,
      tx.observedBalance?.toJSON().amount ?? null,
      tx.referenceAttempts,
      tx.nextReferenceAttemptAt ?? null,
      tx.createdAt,
    ];
  }
}
