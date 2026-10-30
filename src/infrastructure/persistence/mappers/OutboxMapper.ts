import { OutboxMessage } from '../../../domain/messaging/model/OutboxMessage.js';
import { toDate } from './columns.js';

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

export const OUTBOX_COLUMNS =
  'id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at';

export function toOutboxMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: toDate(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at
      ? toDate(row.next_attempt_at)
      : undefined,
    publishedAt: row.published_at ? toDate(row.published_at) : undefined,
  });
}
