import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from '../lib/config.js';
import { healthcheck } from '../lib/api.js';
import { assertReconciled } from '../lib/integrity.js';
import { allWalletIds, createFleet, runOperation } from '../lib/mix.js';
import { spike } from '../lib/thresholds.js';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 200 },
        { duration: '1m', target: 200 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: spike,
};

export function setup() {
  healthcheck();
  return { fleet: createFleet(50) };
}

export default function (data) {
  runOperation(data.fleet);
}

export function teardown(data) {
  const ready = http.get(`${BASE_URL}/health/ready`);
  check(ready, { 'API recovered after the spike': (r) => r.status === 200 });
  assertReconciled(allWalletIds(data.fleet));
}
