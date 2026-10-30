import { z } from 'zod';
import { SUBMITTABLE_KINDS } from '../http/validation/schemas.js';

const text = (max: number) => z.string().min(1).max(max);
const uuid = z.uuid().transform((value) => value.toLowerCase());

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export const wagerMessageEnvelope = z.strictObject({
  messageId: text(200),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({
    providerId: text(100),
    externalTransactionId: text(200),
    idempotencyKey: z
      .string()
      .regex(/^[\x21-\x7e]{1,255}$/, 'must be 1 to 255 printable characters'),
    playerId: uuid,
    walletId: uuid,
    roundId: text(200),
    gameId: text(200),
    kind: z.enum(SUBMITTABLE_KINDS),
    money: z.strictObject({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: text(200).optional(),
  }),
});

export type WagerMessageEnvelope = z.infer<typeof wagerMessageEnvelope>;
