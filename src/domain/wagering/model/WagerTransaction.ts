import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../errors/domain-errors.js';
import { LedgerDirection } from '../../ledger/enums/LedgerDirection.js';
import { Money } from '../../money/model/Money.js';
import { backoffUntil } from '../../shared/backoff.js';
import {
  CreateOpeningTransactionProps,
  CreateWagerTransactionProps,
} from '../dtos/CreateWagerTransactionProps.js';
import { WagerTransactionState } from '../dtos/WagerTransactionState.js';
import { FailureCode } from '../enums/FailureCode.js';
import { WagerTransactionKind as Kind } from '../enums/WagerTransactionKind.js';
import { WagerTransactionStatus as Status } from '../enums/WagerTransactionStatus.js';

const TRANSITIONS: Record<Status, readonly Status[]> = {
  [Status.Pending]: [
    Status.PendingReference,
    Status.Processed,
    Status.Rejected,
    Status.Failed,
  ],
  [Status.PendingReference]: [Status.Processed, Status.Rejected, Status.Failed],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

const REFERENCEABLE: Record<Kind, readonly Kind[]> = {
  [Kind.Opening]: [],
  [Kind.Bet]: [],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

const REQUIRED_TEXT = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'payloadHash',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
] as const;

export const INTERNAL_PROVIDER_ID = '__internal__';

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Kind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: Status;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;
  private _observedBalance?: Money;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt?: Date;

  private constructor(s: WagerTransactionState) {
    this.id = s.id;
    this.providerId = s.providerId;
    this.externalTransactionId = s.externalTransactionId;
    this.idempotencyKey = s.idempotencyKey;
    this.payloadHash = s.payloadHash;
    this.walletId = s.walletId;
    this.playerId = s.playerId;
    this.roundId = s.roundId;
    this.gameId = s.gameId;
    this.kind = s.kind;
    this.money = s.money;
    this.referenceExternalTransactionId = s.referenceExternalTransactionId;
    this.createdAt = s.createdAt;
    this._status = s.status;
    this._referenceTransactionId = s.referenceTransactionId;
    this._failureCode = s.failureCode;
    this._processedAt = s.processedAt;
    this._observedBalance = s.observedBalance;
    this._referenceAttempts = s.referenceAttempts;
    this._nextReferenceAttemptAt = s.nextReferenceAttemptAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new InvalidTransactionError(
        'OPENING is internal and cannot be submitted',
      );
    }
    for (const field of REQUIRED_TEXT) {
      if (typeof props[field] !== 'string' || props[field].trim() === '') {
        throw new InvalidTransactionError(`${field} is required`);
      }
    }
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('amount must be positive');
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined && reference.trim() === '') {
      throw new InvalidTransactionError(
        'referenceExternalTransactionId cannot be blank',
      );
    }
    const needsReference =
      props.kind === Kind.Refund || props.kind === Kind.Rollback;
    if (needsReference && reference === undefined) {
      throw new InvalidTransactionError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (props.kind === Kind.Bet && reference !== undefined) {
      throw new InvalidTransactionError(
        'BET cannot reference another transaction',
      );
    }

    return new WagerTransaction({
      ...props,
      status: Status.Pending,
      referenceAttempts: 0,
    });
  }

  static opening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('amount must be positive');
    }
    const externalTransactionId = `opening:${props.walletId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: Kind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: Status.Pending,
      referenceAttempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): Status {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance?: Money,
  ): void {
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionError(
        `${this.kind} requires the resolved reference`,
      );
    }
    this.transitionTo(Status.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  markPendingReference(now: Date): void {
    this.transitionTo(Status.PendingReference);
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = backoffUntil(0, now);
  }

  scheduleReferenceRetry(now: Date): void {
    if (this._status !== Status.PendingReference) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        Status.PendingReference,
      );
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = backoffUntil(this._referenceAttempts, now);
  }

  reject(code: FailureCode, observedBalance?: Money): void {
    this.transitionTo(Status.Rejected);
    this._failureCode = code;
    this._observedBalance = observedBalance;
  }

  fail(code: FailureCode): void {
    this.transitionTo(Status.Failed);
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  isReferenceRetryDue(now: Date): boolean {
    return (
      this._status === Status.PendingReference &&
      this._nextReferenceAttemptAt !== undefined &&
      this._nextReferenceAttemptAt.getTime() <= now.getTime()
    );
  }

  overdrawFailureCode(): FailureCode {
    return this.kind === Kind.Bet
      ? FailureCode.InsufficientFunds
      : FailureCode.ReversalWouldOverdraw;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Rollback: {
        if (!reference)
          throw new InvalidTransactionError(
            'ROLLBACK needs its reference to pick the direction',
          );
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case Kind.Loss:
        throw new InvalidTransactionError('LOSS has no ledger effect');
    }
  }

  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!REFERENCEABLE[this.kind].includes(reference.kind))
      return FailureCode.InvalidReferenceKind;
    if (reference.status !== Status.Processed)
      return FailureCode.ReferenceNotProcessed;
    if (this.requiresReference() && !reference.money.equals(this.money))
      return FailureCode.AmountMismatch;
    return undefined;
  }

  private transitionTo(next: Status): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
    this._nextReferenceAttemptAt = undefined;
  }
}
