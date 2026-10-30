import { randomUUID } from 'node:crypto';
import { MessageOutcomePolicy } from '../../src/application/services/MessageOutcomePolicy.js';
import { UnitOfWork } from '../../src/application/ports/UnitOfWork.js';
import { SubmitWagerTransaction } from '../../src/application/use-cases/SubmitWagerTransaction.js';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { WagerMessageHandler } from '../../src/interface/sqs/WagerMessageHandler.js';
import { harness } from '../application/fakes/harness.js';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

const message = (
  over: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
) => ({
  messageId: `msg-${randomUUID()}`,
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...data,
  },
  ...over,
});

function setup(uowOverride?: (real: UnitOfWork) => UnitOfWork) {
  const h = harness();
  h.db.seedWallet('1000.00', WALLET, PLAYER);
  const uow = uowOverride ? uowOverride(h.db.uow) : h.db.uow;
  const submit = new SubmitWagerTransaction(
    uow,
    h.clock,
    h.ids,
    h.processor,
    h.metrics,
  );
  const policy = new MessageOutcomePolicy({
    maxAttempts: 3,
    retryBaseSeconds: 5,
    retryMaxSeconds: 60,
  });
  const handler = new WagerMessageHandler(submit, policy, h.metrics, h.logger);
  const handle = (body: unknown, receiveCount = 1) =>
    handler.handle({
      body: typeof body === 'string' ? body : JSON.stringify(body),
      receiveCount,
    });
  return { ...h, handle };
}

const balance = (s: ReturnType<typeof setup>) =>
  s.db.wallets.get(WALLET)!.balance.toJSON().amount;

describe('WagerMessageHandler', () => {
  describe('processing', () => {
    it('applies a valid message and acknowledges it', async () => {
      const s = setup();

      expect(await s.handle(message())).toEqual({ kind: 'ack' });

      expect(balance(s)).toBe('975.00');
      const [tx] = [...s.db.transactions.values()];
      expect(tx).toMatchObject({
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        idempotencyKey: 'provider-a:transaction-123',
        status: Status.Processed,
      });
    });

    it('records the message in the inbox as processed', async () => {
      const s = setup();
      const msg = message({ messageId: 'msg-123' });

      await s.handle(msg);

      expect(s.db.inbox.get('wager-transactions:msg-123')?.isProcessed()).toBe(
        true,
      );
    });

    it('a redelivery of the same message has no further effect', async () => {
      const s = setup();
      const msg = message();

      await s.handle(msg);
      expect(await s.handle(msg, 2)).toEqual({ kind: 'ack' });

      expect(balance(s)).toBe('975.00');
      expect(s.db.ledger).toHaveLength(2);
    });

    it('the same operation under another message id is a duplicate, not a second debit', async () => {
      const s = setup();

      await s.handle(message());
      expect(await s.handle(message())).toEqual({ kind: 'ack' });

      expect(balance(s)).toBe('975.00');
      expect(s.db.ledger).toHaveLength(2);
    });

    it('acknowledges a business rejection: it is a final answer, not a failure', async () => {
      const s = setup();

      const action = await s.handle(
        message({}, { money: { amount: '5000.00', currency: 'BRL' } }),
      );

      expect(action).toEqual({ kind: 'ack' });
      expect(balance(s)).toBe('1000.00');
      expect([...s.db.transactions.values()][0].status).toBe(Status.Rejected);
    });

    it('acknowledges an operation parked for a missing reference', async () => {
      const s = setup();

      const action = await s.handle(
        message(
          {},
          { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' },
        ),
      );

      expect(action).toEqual({ kind: 'ack' });
      expect([...s.db.transactions.values()][0].status).toBe(
        Status.PendingReference,
      );
    });
  });

  describe('malformed messages go to the dead-letter queue', () => {
    it.each([
      ['not json', 'this is not json'],
      ['an array', []],
      ['a wrong type', message({ type: 'SomethingElse' })],
      ['an unknown envelope field', message({ extra: true })],
      ['an unknown data field', message({}, { extra: true })],
      ['a missing message id', message({ messageId: undefined })],
      ['a non-uuid wallet', message({}, { walletId: 'w1' })],
      ['the internal OPENING kind', message({}, { kind: 'OPENING' })],
      ['a bad timestamp', message({ occurredAt: 'yesterday' })],
      [
        'a numeric amount',
        message({}, { money: { amount: 25, currency: 'BRL' } }),
      ],
    ])('%s', async (_name, body) => {
      const s = setup();

      expect(await s.handle(body)).toEqual({
        kind: 'dead-letter',
        reason: 'MALFORMED',
      });
      expect(s.db.transactions.size).toBe(0);
    });

    it('counts them without logging the payload', async () => {
      const s = setup();

      await s.handle(message({}, { money: { amount: 25, currency: 'BRL' } }));
      await s.handle('garbage with 25.00 inside');

      expect(
        s.metrics.counters.filter(
          (c) => c.name === 'sqs_malformed_messages_total',
        ),
      ).toEqual([
        { name: 'sqs_malformed_messages_total', labels: { cause: 'schema' } },
        { name: 'sqs_malformed_messages_total', labels: { cause: 'json' } },
      ]);
      expect(JSON.stringify(s.logger.entries)).not.toMatch(/garbage|25\.00/);
    });
  });

  describe('permanent business errors go to the dead-letter queue', () => {
    it.each(['25.001', '-5.00', '1e3'])('invalid money %s', async (amount) => {
      const s = setup();

      const action = await s.handle(
        message({}, { money: { amount, currency: 'BRL' } }),
      );

      expect(action).toEqual({ kind: 'dead-letter', reason: 'INVALID' });
      expect(balance(s)).toBe('1000.00');
    });

    it('an idempotency key reused with different content is a conflict that changes nothing', async () => {
      const s = setup();
      await s.handle(message());

      const action = await s.handle(
        message({}, { money: { amount: '30.00', currency: 'BRL' } }),
      );

      expect(action).toEqual({ kind: 'dead-letter', reason: 'CONFLICT' });
      expect(balance(s)).toBe('975.00');
    });
  });

  describe('transient failures are retried with backoff, then dead-lettered', () => {
    const failing = (): ((real: UnitOfWork) => UnitOfWork) => () => ({
      run: () =>
        Promise.reject(
          Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
        ),
    });

    it('retries with an exponentially growing delay', async () => {
      const s = setup(failing());
      const msg = message();

      expect(await s.handle(msg, 1)).toEqual({
        kind: 'retry',
        delaySeconds: 5,
      });
      expect(await s.handle(msg, 2)).toEqual({
        kind: 'retry',
        delaySeconds: 10,
      });
    });

    it('gives up at the attempt limit', async () => {
      const s = setup(failing());

      expect(await s.handle(message(), 3)).toEqual({
        kind: 'dead-letter',
        reason: 'RETRIES_EXHAUSTED',
      });
    });

    it('logs the failure with ids but without the amount', async () => {
      const s = setup(failing());

      await s.handle(message());

      const entry = s.logger.entries.find(
        (e) => e.message === 'wager message failed',
      );
      expect(entry?.fields).toMatchObject({
        walletId: WALLET,
        providerId: 'provider-a',
        action: 'retry',
      });
      expect(JSON.stringify(entry?.fields)).not.toContain('25.00');
    });
  });
});
