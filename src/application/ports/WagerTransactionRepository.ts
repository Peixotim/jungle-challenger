import { WagerTransactionKind } from '../../domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransaction } from '../../domain/wagering/model/WagerTransaction.js';

export interface InsertIfAbsentResult {
  transaction: WagerTransaction;
  inserted: boolean;
}

export abstract class WagerTransactionRepository {
  abstract insertIfAbsent(
    candidate: WagerTransaction,
  ): Promise<InsertIfAbsentResult>;

  abstract save(transaction: WagerTransaction): Promise<void>;

  abstract findById(id: string): Promise<WagerTransaction | undefined>;

  abstract findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  abstract hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean>;

  abstract claimNextDueForReference(
    now: Date,
  ): Promise<WagerTransaction | undefined>;
}
