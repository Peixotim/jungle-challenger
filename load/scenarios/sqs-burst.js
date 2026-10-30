import exec from 'k6/execution';
import { check } from 'k6';
import { Gauge } from 'k6/metrics';
import { SQS } from '../lib/config.js';
import { createWallet, getLedger, getWallet, healthcheck } from '../lib/api.js';
import { assertReconciled } from '../lib/integrity.js';
import {
  assertQueuesEmpty,
  queueCounts,
  sendWager,
  waitDrained,
  wagerEnvelope,
} from '../lib/sqs.js';
import { sqsBurst } from '../lib/thresholds.js';

const MESSAGES = 5000;
const WALLETS = 50;
const PER_WALLET = MESSAGES / WALLETS;

const drainSeconds = new Gauge('sqs_drain_seconds');
const drainRate = new Gauge('sqs_drain_msgs_per_sec');

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: MESSAGES,
    },
  },
  teardownTimeout: '10m',
  thresholds: sqsBurst,
};

export function setup() {
  healthcheck();
  assertQueuesEmpty();
  return {
    wallets: Array.from({ length: WALLETS }, () => createWallet('1000000.00')),
    startedAt: Date.now(),
  };
}

export default function (data) {
  const wallet = data.wallets[exec.scenario.iterationInTest % WALLETS];
  sendWager(wagerEnvelope(wallet));
}

export function teardown(data) {
  const drained = waitDrained() !== null;
  const seconds = (Date.now() - data.startedAt) / 1000;
  drainSeconds.add(seconds);
  drainRate.add(MESSAGES / seconds);

  check(null, {
    'main queue drained within the timeout': () => drained,
    'DLQ is empty': () => {
      const dlq = queueCounts(SQS.dlqUrl);
      return dlq.visible + dlq.inFlight + dlq.delayed === 0;
    },
  });

  for (const wallet of data.wallets) {
    const debits = getLedger(wallet.id).filter((e) => e.direction === 'DEBIT');
    check(null, {
      [`each wallet has ${PER_WALLET} debits`]: () => debits.length === PER_WALLET,
      'each wallet balance matches the debits': () =>
        Number(getWallet(wallet.id).body.balance.amount) === 1000000 - PER_WALLET,
    });
  }
  assertReconciled(data.wallets.map((w) => w.id));
}
