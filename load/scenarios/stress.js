import { healthcheck } from '../lib/api.js';
import { assertReconciled } from '../lib/integrity.js';
import { allWalletIds, createFleet, runOperation } from '../lib/mix.js';
import { STRESS_STEPS, stress } from '../lib/thresholds.js';

const STEP_SECONDS = 60;

export const options = {
  scenarios: Object.fromEntries(
    STRESS_STEPS.map((rate, index) => [
      `step_${rate}`,
      {
        executor: 'constant-arrival-rate',
        rate,
        timeUnit: '1s',
        duration: `${STEP_SECONDS}s`,
        startTime: `${index * STEP_SECONDS}s`,
        preAllocatedVUs: 200,
        maxVUs: 1000,
        tags: { step: String(rate) },
      },
    ]),
  ),
  thresholds: stress,
};

export function setup() {
  healthcheck();
  return { fleet: createFleet(100) };
}

export default function (data) {
  runOperation(data.fleet);
}

export function teardown(data) {
  assertReconciled(allWalletIds(data.fleet));
}
