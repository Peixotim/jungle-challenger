import exec from 'k6/execution';
import { check } from 'k6';
import { SQS } from '../lib/config.js';
import {
  createWallet,
  getLedger,
  getWallet,
  healthcheck,
  metricValue,
  money,
} from '../lib/api.js';
import { assertReconciled } from '../lib/integrity.js';
import {
  assertQueuesEmpty,
  purgeQueue,
  queueCounts,
  sendWager,
  waitDrained,
  wagerEnvelope,
} from '../lib/sqs.js';
import { idempotencySqs } from '../lib/thresholds.js';

const WALLETS_PER_CASE = 25;
const CASES = ['sameMessageId', 'appReplay', 'payloadMismatch', 'externalIdReused'];
const DLQ_EXPECTED = 2 * WALLETS_PER_CASE; // payloadMismatch + externalIdReused
const DUPLICATES_EXPECTED = 2 * WALLETS_PER_CASE * 4; // sameMessageId + appReplay

export const options = {
  scenarios: {
    idempotency: {
      executor: 'shared-iterations',
      vus: 20,
      iterations: CASES.length * WALLETS_PER_CASE,
    },
  },
  teardownTimeout: '10m',
  thresholds: idempotencySqs,
};

export function setup() {
  healthcheck();
  assertQueuesEmpty();
  return {
    wallets: Array.from({ length: CASES.length * WALLETS_PER_CASE }, () =>
      createWallet('1000.00'),
    ),
    duplicatesBefore: metricValue('wager_duplicates_total'),
  };
}

// Sent in order on the wallet's FIFO group: the original always lands first.
export default function (data) {
  const index = exec.scenario.iterationInTest;
  const wallet = data.wallets[index];
  const kind = CASES[Math.floor(index / WALLETS_PER_CASE)];
  const original = wagerEnvelope(wallet, { data: { money: money('10.00') } });
  sendWager(original);

  for (let copy = 1; copy <= 4; copy++) {
    if (kind === 'sameMessageId') {
      sendWager({
        ...original,
        occurredAt: new Date(Date.now() + copy).toISOString(),
      });
    } else if (kind === 'appReplay') {
      sendWager({ ...original, messageId: `msg-${crypto.randomUUID()}` });
    }
  }

  if (kind === 'payloadMismatch') {
    sendWager({
      ...original,
      messageId: `msg-${crypto.randomUUID()}`,
      data: { ...original.data, money: money('11.00') },
    });
  } else if (kind === 'externalIdReused') {
    sendWager({
      ...original,
      messageId: `msg-${crypto.randomUUID()}`,
      data: {
        ...original.data,
        idempotencyKey: `${original.data.idempotencyKey}-other`,
      },
    });
  }
}

export function teardown(data) {
  const drained = waitDrained() !== null;
  const dlq = queueCounts(SQS.dlqUrl);
  const duplicates = metricValue('wager_duplicates_total') - data.duplicatesBefore;

  check(null, {
    'main queue drained within the timeout': () => drained,
    'DLQ holds exactly the conflicting messages': () =>
      dlq.visible + dlq.inFlight + dlq.delayed === DLQ_EXPECTED,
    'duplicates reached the application': () => duplicates >= DUPLICATES_EXPECTED,
  });

  for (const wallet of data.wallets) {
    const debits = getLedger(wallet.id).filter((e) => e.direction === 'DEBIT');
    check(null, {
      'exactly one debit per wallet': () => debits.length === 1,
      'balance reflects a single bet': () =>
        Number(getWallet(wallet.id).body.balance.amount) === 990,
    });
  }
  assertReconciled(data.wallets.map((w) => w.id));
  // The conflicting messages are expected in the DLQ; leave it empty for the next run.
  purgeQueue(SQS.dlqUrl);
}
