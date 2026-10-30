import { check } from 'k6';
import {
  createWallet,
  getWallet,
  healthcheck,
  idempotencyKeyFor,
  submit,
  wagerBody,
} from '../lib/api.js';
import { assertReconciled, integrityThreshold } from '../lib/integrity.js';
import { smoke } from '../lib/thresholds.js';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: { ...smoke, ...integrityThreshold },
};

export function setup() {
  healthcheck();
  return { wallets: [1, 2, 3].map(() => createWallet('1000.00')) };
}

export default function (data) {
  const wallet = data.wallets[__ITER % data.wallets.length];
  const body = wagerBody(wallet);
  const response = submit(body, idempotencyKeyFor(body));
  check(response, {
    'bet processed (200)': (r) => r.status === 200,
    'bet returns balance': (r) => r.json('balance') !== undefined,
  });

  const read = getWallet(wallet.id);
  check(read.response, { 'wallet read (200)': (r) => r.status === 200 });
}

export function teardown(data) {
  assertReconciled(data.wallets.map((w) => w.id));
}
