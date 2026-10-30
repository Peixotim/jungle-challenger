import { integrityThreshold } from './integrity.js';

export const smoke = {
  http_req_duration: ['p(95)<300'],
  http_req_failed: ['rate==0'],
  checks: ['rate==1'],
  ...integrityThreshold,
};

export const spike = {
  http_req_duration: ['p(95)<800', 'p(99)<2000'],
  http_req_failed: ['rate<0.01'],
  checks: ['rate==1'],
  ...integrityThreshold,
};

// Latency is evaluated per arrival-rate step (tag "step"); the highest step that
// passes is the sustained limit. Only the error rate aborts the run.
export const STRESS_STEPS = [100, 200, 400, 600, 800, 1000, 1200];
export const stress = {
  http_req_failed: [
    { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' },
  ],
  checks: ['rate==1'],
  ...Object.fromEntries(
    STRESS_STEPS.map((rate) => [
      `http_req_duration{step:${rate}}`,
      ['p(95)<1000'],
    ]),
  ),
  ...integrityThreshold,
};

export const soak = {
  'http_req_duration{phase:first}': ['p(95)<1000'],
  'http_req_duration{phase:mid}': ['p(95)<1000'],
  'http_req_duration{phase:last}': ['p(95)<1000'],
  http_req_failed: ['rate<0.005'],
  checks: ['rate==1'],
  ...integrityThreshold,
};

// The max>=0 limits are always true: they only make k6 print latency per wallet shape.
export const contention = {
  'http_req_duration{shape:one-wallet}': ['max>=0'],
  'http_req_duration{shape:many-wallets}': ['max>=0'],
  http_req_failed: ['rate<0.01'],
  checks: ['rate==1'],
  ...integrityThreshold,
};

export const idempotencyHttp = {
  http_req_failed: ['rate==0'],
  checks: ['rate==1'],
  ...integrityThreshold,
};

export const sqsBurst = {
  checks: ['rate==1'],
  ...integrityThreshold,
};

export const idempotencySqs = {
  checks: ['rate==1'],
  ...integrityThreshold,
};
