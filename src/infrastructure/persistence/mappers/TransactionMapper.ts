import { FailureCode } from '../../../domain/wagering/enums/FailureCode.js';
import { WagerTransactionKind } from '../../../domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/WagerTransactionStatus.js';
import { WagerTransaction } from '../../../domain/wagering/model/WagerTransaction.js';
import { toDate, toMoney, toMoneyOrUndefined } from './columns.js';

export interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  status: WagerTransactionStatus;
  reference_transaction_id: string | null;
  failure_code: FailureCode | null;
  processed_at: Date | string | null;
  observed_balance: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | string | null;
  created_at: Date | string;
}

export const TRANSACTION_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key,
  payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency,
  reference_external_transaction_id, status, reference_transaction_id, failure_code,
  processed_at, observed_balance, reference_attempts, next_reference_attempt_at, created_at`;

export function toTransaction(row: TransactionRow): WagerTransaction {
  const currency = row.currency.trim();
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: toMoney(row.amount, currency),
    referenceExternalTransactionId:
      row.reference_external_transaction_id ?? undefined,
    createdAt: toDate(row.created_at),
    status: row.status,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: row.failure_code ?? undefined,
    processedAt: row.processed_at ? toDate(row.processed_at) : undefined,
    observedBalance: toMoneyOrUndefined(row.observed_balance, currency),
    referenceAttempts: Number(row.reference_attempts),
    nextReferenceAttemptAt: row.next_reference_attempt_at
      ? toDate(row.next_reference_attempt_at)
      : undefined,
  });
}
