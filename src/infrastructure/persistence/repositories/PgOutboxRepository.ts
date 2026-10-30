import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../../application/ports/OutboxRepository.js';
import { OutboxMessage } from '../../../domain/messaging/model/OutboxMessage.js';
import {
  OUTBOX_COLUMNS,
  OutboxRow,
  toOutboxMessage,
} from '../mappers/OutboxMapper.js';

export class PgOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `insert into outbox_messages (${OUTBOX_COLUMNS})
       values (?, ?, ?, ?::jsonb, ?, ?, ?, ?)
       on conflict (id) do nothing`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
      ],
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxRow[]>(
      `select ${OUTBOX_COLUMNS} from outbox_messages
        where published_at is null
          and (next_attempt_at is null or next_attempt_at <= ?)
        order by occurred_at
        limit ?
        for update skip locked`,
      [now, limit],
    );
    return rows.map(toOutboxMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, published_at = ?
        where id = ?`,
      [
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
        message.id,
      ],
    );
  }
}
