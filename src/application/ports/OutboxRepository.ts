import { OutboxMessage } from '../../domain/messaging/model/OutboxMessage.js';

export abstract class OutboxRepository {
  abstract enqueue(message: OutboxMessage): Promise<void>;

  abstract claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;

  abstract save(message: OutboxMessage): Promise<void>;
}
