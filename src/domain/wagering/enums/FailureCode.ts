/**
 * Stable, machine-readable reasons. What the provider should do:
 * - give up / wait for player action: INSUFFICIENT_FUNDS, REVERSAL_WOULD_OVERDRAW, ALREADY_REVERSED
 * - fix the payload and resend with a new key: AMOUNT_MISMATCH, REFERENCE_MISMATCH,
 *   INVALID_REFERENCE_KIND, REFERENCE_NOT_PROCESSED, WALLET_NOT_FOUND, WALLET_PLAYER_MISMATCH,
 *   CURRENCY_MISMATCH
 * - send the referenced transaction first, then resend: REFERENCE_NOT_FOUND
 * - FAILED only: INTERNAL_ERROR (operator investigation)
 */
export enum FailureCode {
  // BET without balance
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  // REFUND/ROLLBACK that would drive the balance negative (operationally different from a BET)
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  // referenced transaction never arrived (pending-reference attempts exhausted)
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  // reference differs in provider, player, wallet, currency or round
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  // reference kind not allowed for this operation (e.g. REFUND of a WIN)
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  // reference exists but was not PROCESSED (rejected or failed)
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  // reference already reverted by the same kind of operation
  AlreadyReversed = 'ALREADY_REVERSED',
  // REFUND/ROLLBACK amount differs from the reference amount
  AmountMismatch = 'AMOUNT_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  // wallet does not belong to the given player
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  // operation currency differs from the wallet currency
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  // permanent infrastructure error (FAILED)
  InternalError = 'INTERNAL_ERROR',
}
