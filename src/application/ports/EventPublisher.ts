import { OutboxMessage } from '../../domain/messaging/model/OutboxMessage.js';

export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}
