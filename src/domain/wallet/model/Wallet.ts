import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidWalletError,
} from '../../errors/domain-errors.js';
import { LedgerDirection } from '../../ledger/enums/LedgerDirection.js';
import { WalletLedgerEntry } from '../../ledger/model/WalletLedgerEntry.js';
import { Money } from '../../money/model/Money.js';
import { OpenedWallet, OpenWalletProps } from '../dtos/OpenWalletProps.js';
import { WalletMovement } from '../dtos/WalletMovement.js';
import { WalletState } from '../dtos/WalletState.js';

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open({
    id,
    playerId,
    initialBalance,
    now,
    opening,
  }: OpenWalletProps): OpenedWallet {
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance cannot be negative');
    }
    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      initialBalance,
      1,
      now,
      now,
    );
    if (!initialBalance.isPositive()) return { wallet };
    if (!opening) {
      throw new InvalidWalletError(
        'opening ids are required when initial balance is positive',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: now,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(
    direction: LedgerDirection,
    { entryId, transactionId, money, at }: WalletMovement,
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive())
      throw new InvalidMoneyError('movement amount must be positive');

    const before = this._balance;
    const after =
      direction === LedgerDirection.Debit
        ? before.subtract(money)
        : before.add(money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(
        `insufficient funds: balance ${before}, requested ${money}`,
      );
    }

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency)
      throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
