import exec from 'k6/execution';
import { healthcheck } from '../lib/api.js';
import { assertReconciled } from '../lib/integrity.js';
import { allWalletIds, createFleet, runOperation } from '../lib/mix.js';
import { soak } from '../lib/thresholds.js';

const DURATION_MS = 10 * 60 * 1000;
// ponytail: ~40% of the sustained stress limit measured here (600 req/s); re-measure on other machines
const SOAK_RATE = Number(__ENV.SOAK_RATE || 240);

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: SOAK_RATE,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 100,
      maxVUs: 500,
    },
  },
  thresholds: soak,
};

function phase() {
  const elapsed = exec.instance.currentTestRunDuration;
  if (elapsed < DURATION_MS / 3) return 'first';
  if (elapsed < (2 * DURATION_MS) / 3) return 'mid';
  return 'last';
}

export function setup() {
  healthcheck();
  return { fleet: createFleet(50) };
}

export default function (data) {
  exec.vu.metrics.tags.phase = phase();
  runOperation(data.fleet);
}

export function teardown(data) {
  assertReconciled(allWalletIds(data.fleet));
}
