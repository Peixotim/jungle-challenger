import exec from 'k6/execution';
import { check } from 'k6';
import {
  createWallet,
  healthcheck,
  idempotencyKeyFor,
  submit,
  wagerBody,
} from '../lib/api.js';
import { assertReconciled } from '../lib/integrity.js';
import { contention } from '../lib/thresholds.js';

const SHAPES = [
  { name: 'one-wallet', wallets: 1 },
  { name: 'many-wallets', wallets: 100 },
];
const SHAPE_SECONDS = 60;
const PAUSE_SECONDS = 10;

export const options = {
  scenarios: Object.fromEntries(
    SHAPES.map((shape, index) => [
      shape.name,
      {
        executor: 'constant-vus',
        vus: 50,
        duration: `${SHAPE_SECONDS}s`,
        startTime: `${index * (SHAPE_SECONDS + PAUSE_SECONDS)}s`,
        tags: { shape: shape.name },
      },
    ]),
  ),
  thresholds: contention,
};

export function setup() {
  healthcheck();
  return Object.fromEntries(
    SHAPES.map((shape) => [
      shape.name,
      Array.from({ length: shape.wallets }, () => createWallet('1000000.00')),
    ]),
  );
}

export default function (data) {
  const wallets = data[exec.scenario.name];
  const wallet = wallets[__VU % wallets.length];
  const body = wagerBody(wallet);
  const response = submit(body, idempotencyKeyFor(body));
  check(response, { 'bet processed (200)': (r) => r.status === 200 });
}

export function teardown(data) {
  assertReconciled(
    Object.values(data)
      .flat()
      .map((wallet) => wallet.id),
  );
}
