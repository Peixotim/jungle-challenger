import {
  CurrencyMismatchError,
  InvalidLedgerEntryError,
} from '../../errors/domain-errors.js';
import { Money } from '../../money/model/Money.js';
import { CreateLedgerEntryProps } from '../dtos/CreateLedgerEntryProps.js';
import { LedgerEntryState } from '../dtos/LedgerEntryState.js';
import { LedgerDirection } from '../enums/LedgerDirection.js';

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    for (const other of [balanceBefore, balanceAfter]) {
      if (other.currency !== money.currency) {
        throw new CurrencyMismatchError(money.currency, other.currency);
      }
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry amount must be positive');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError(
        'ledger entry balances cannot be negative',
      );
    }
    const entry: WalletLedgerEntry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `unbalanced entry: ${balanceBefore} ${props.direction} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    if (
      this.balanceBefore.currency !== this.money.currency ||
      this.balanceAfter.currency !== this.money.currency
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
