export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: wallet opening credit, never submitted by a provider
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}
