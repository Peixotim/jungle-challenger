import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxRepository } from '../../../application/ports/InboxRepository.js';
import { InboxMessage } from '../../../domain/messaging/model/InboxMessage.js';

export class PgInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async receiveIfAbsent(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<unknown[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict do nothing
       returning message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
      ],
    );
    return rows.length === 1;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(
      `update inbox_messages set processed_at = ?
        where consumer_name = ? and message_id = ?`,
      [message.processedAt ?? null, message.consumerName, message.messageId],
    );
  }
}
