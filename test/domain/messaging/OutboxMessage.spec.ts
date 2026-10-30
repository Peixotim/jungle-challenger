import { InvalidMessageStateError } from '../../../src/domain/errors/domain-errors.js';
import { IntegrationEvent } from '../../../src/domain/events/model/IntegrationEvent.js';
import { OutboxMessage } from '../../../src/domain/messaging/model/OutboxMessage.js';

class TestEvent extends IntegrationEvent<{ value: string }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  static make() {
    return new TestEvent({
      eventId: 'evt-1',
      aggregateId: 'agg-1',
      correlationId: 'corr-1',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      data: { value: 'x' },
    });
  }
}

const now = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('OutboxMessage', () => {
  it('enqueue copies the event envelope and starts pending and due', () => {
    const msg = OutboxMessage.enqueue(TestEvent.make());
    expect(msg.id).toBe('evt-1');
    expect(msg.aggregateId).toBe('agg-1');
    expect(msg.eventType).toBe('TestEvent');
    expect(msg.payload).toMatchObject({
      eventId: 'evt-1',
      version: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: { value: 'x' },
    });
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(now)).toBe(true);
  });

  it('scheduleRetry counts attempts and postpones with exponential backoff', () => {
    const msg = OutboxMessage.enqueue(TestEvent.make());
    msg.scheduleRetry(now);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(at(2_000));
    expect(msg.isDue(at(1_999))).toBe(false);
    expect(msg.isDue(at(2_000))).toBe(true);

    msg.scheduleRetry(now);
    expect(msg.nextAttemptAt).toEqual(at(4_000));
  });

  it('caps the backoff at 5 minutes', () => {
    const msg = OutboxMessage.enqueue(TestEvent.make());
    for (let i = 0; i < 30; i++) msg.scheduleRetry(now);
    expect(msg.nextAttemptAt).toEqual(at(5 * 60_000));
  });

  it('markPublished ends the lifecycle', () => {
    const msg = OutboxMessage.enqueue(TestEvent.make());
    msg.markPublished(at(10));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at(1_000_000))).toBe(false);
    expect(msg.publishedAt).toEqual(at(10));
    expect(() => msg.markPublished(at(20))).toThrow(InvalidMessageStateError);
    expect(() => msg.scheduleRetry(at(20))).toThrow(InvalidMessageStateError);
  });

  it('rehydrate restores state', () => {
    const msg = OutboxMessage.rehydrate({
      id: 'i',
      aggregateId: 'a',
      eventType: 'E',
      payload: {},
      occurredAt: now,
      attempts: 3,
      nextAttemptAt: at(8_000),
    });
    expect(msg.attempts).toBe(3);
    expect(msg.isDue(at(7_999))).toBe(false);
  });
});
