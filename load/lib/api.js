import http from 'k6/http';
import exec from 'k6/execution';
import { BASE_URL, CURRENCY, PROVIDER_ID } from './config.js';

// Only 5xx and network failures count as http_req_failed; 4xx are asserted by each scenario.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function money(amount) {
  return { amount, currency: CURRENCY };
}

export function healthcheck() {
  const response = http.get(`${BASE_URL}/health/ready`);
  if (response.status !== 200) {
    exec.test.abort(
      `API not ready at ${BASE_URL} (GET /health/ready -> ${response.status}). Start it with "bun run start:bun".`,
    );
  }
}

export function createWallet(balance) {
  const playerId = crypto.randomUUID();
  const response = http.post(
    `${BASE_URL}/wallets`,
    JSON.stringify({ playerId, initialBalance: money(balance) }),
    { headers: JSON_HEADERS },
  );
  if (response.status !== 201) {
    exec.test.abort(`could not create a wallet: ${response.status} ${response.body}`);
  }
  return { id: response.json('id'), playerId };
}

export function getWallet(id, params) {
  const response = http.get(`${BASE_URL}/wallets/${id}`, params);
  return { response, body: response.status === 200 ? response.json() : undefined };
}

export function getLedger(id) {
  const entries = [];
  let cursor;
  do {
    const query = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = http.get(`${BASE_URL}/wallets/${id}/ledger?${query}`);
    if (response.status !== 200) {
      exec.test.abort(`ledger read failed: ${response.status} ${response.body}`);
    }
    const page = response.json();
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}

export function reconcile(id) {
  const response = http.post(`${BASE_URL}/wallets/${id}/reconciliation`);
  return response.status === 200 ? response.json() : { consistent: false };
}

export function submit(body, key, params = {}) {
  return http.post(`${BASE_URL}/wagering/transactions`, JSON.stringify(body), {
    ...params,
    headers: { ...JSON_HEADERS, 'Idempotency-Key': key, ...params.headers },
  });
}

export function submitRequest(body, key, params = {}) {
  return {
    method: 'POST',
    url: `${BASE_URL}/wagering/transactions`,
    body: JSON.stringify(body),
    params: {
      ...params,
      headers: { ...JSON_HEADERS, 'Idempotency-Key': key, ...params.headers },
    },
  };
}

export function externalId() {
  return `ext-${crypto.randomUUID()}`;
}

export function idempotencyKeyFor(body) {
  return `${body.providerId}:${body.externalTransactionId}`;
}

export function wagerBody(wallet, over = {}) {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId: externalId(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-load',
    gameId: 'game-load',
    kind: 'BET',
    money: money('1.00'),
    ...over,
  };
}

// Sums every series of a Prometheus counter, e.g. wager_duplicates_total{kind="BET"}.
export function metricValue(name) {
  return http
    .get(`${BASE_URL}/metrics`)
    .body.split('\n')
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}
