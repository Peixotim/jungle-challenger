import { InboxMessage } from '../../domain/messaging/model/InboxMessage.js';

export abstract class InboxRepository {
  abstract receiveIfAbsent(message: InboxMessage): Promise<boolean>;

  abstract markProcessed(message: InboxMessage): Promise<void>;
}
