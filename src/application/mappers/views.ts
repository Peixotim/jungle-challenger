import { WalletLedgerEntry } from '../../domain/ledger/model/WalletLedgerEntry.js';
import { WagerTransaction } from '../../domain/wagering/model/WagerTransaction.js';
import { Wallet } from '../../domain/wallet/model/Wallet.js';
import { LedgerEntryView } from '../dtos/LedgerPageView.js';
import { SubmitWagerTransactionResult } from '../dtos/SubmitWagerTransactionResult.js';
import { WagerTransactionView } from '../dtos/WagerTransactionView.js';
import { WalletView } from '../dtos/WalletView.js';

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toWagerTransactionView(
  tx: WagerTransaction,
): WagerTransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    failureCode: tx.failureCode,
    balance: tx.observedBalance?.toJSON(),
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString(),
  };
}

export function toSubmitResult(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): SubmitWagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}
