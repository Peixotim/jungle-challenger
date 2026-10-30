import { InvalidMessageStateError } from '../../../src/domain/errors/domain-errors.js';
import { InboxMessage } from '../../../src/domain/messaging/model/InboxMessage.js';

const receivedAt = new Date('2026-01-01T00:00:00Z');
const receive = (over = {}) =>
  InboxMessage.receive({
    messageId: 'msg-1',
    consumerName: 'wager-consumer',
    payloadHash: 'h',
    receivedAt,
    ...over,
  });

describe('InboxMessage', () => {
  it('is received unprocessed', () => {
    const msg = receive();
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
  });

  it('markProcessed stores the time and refuses a second call', () => {
    const msg = receive();
    const at = new Date('2026-01-01T00:00:05Z');
    msg.markProcessed(at);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(at);
    expect(() => msg.markProcessed(at)).toThrow(InvalidMessageStateError);
  });

  it('requires messageId and consumerName', () => {
    expect(() => receive({ messageId: ' ' })).toThrow(InvalidMessageStateError);
    expect(() => receive({ consumerName: '' })).toThrow(
      InvalidMessageStateError,
    );
  });

  it('rehydrate restores a processed message', () => {
    const processedAt = new Date('2026-01-01T00:00:09Z');
    const msg = InboxMessage.rehydrate({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt,
      processedAt,
    });
    expect(msg.isProcessed()).toBe(true);
  });
});
