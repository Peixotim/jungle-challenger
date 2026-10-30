import { z } from 'zod';

const money = z.strictObject({
  amount: z.string(),
  currency: z.string(),
});

const text = (max: number) => z.string().min(1).max(max);
const uuid = z.uuid().transform((value) => value.toLowerCase());

export const SUBMITTABLE_KINDS = [
  'BET',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
] as const;

export const createWalletBody = z.strictObject({
  playerId: uuid,
  initialBalance: money,
});

export const submitTransactionBody = z.strictObject({
  providerId: text(100),
  externalTransactionId: text(200),
  playerId: uuid,
  walletId: uuid,
  roundId: text(200),
  gameId: text(200),
  kind: z.enum(SUBMITTABLE_KINDS),
  money,
  referenceExternalTransactionId: text(200).optional(),
});

export const idempotencyKeyHeader = z
  .string({ error: 'the Idempotency-Key header is required' })
  .regex(/^[\x21-\x7e]{1,255}$/, {
    error: 'must be 1 to 255 printable characters without spaces',
  });

export const ledgerQuery = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type CreateWalletBody = z.infer<typeof createWalletBody>;
export type SubmitTransactionBody = z.infer<typeof submitTransactionBody>;
export type LedgerQuery = z.infer<typeof ledgerQuery>;
