import http from 'k6/http';
import { check } from 'k6';
import {
  createWallet,
  externalId,
  getLedger,
  getWallet,
  healthcheck,
  idempotencyKeyFor,
  metricValue,
  money,
  submit,
  submitRequest,
  wagerBody,
} from '../lib/api.js';
import { assertReconciled } from '../lib/integrity.js';
import { idempotencyHttp } from '../lib/thresholds.js';

const COPIES = 25;
const SAME_PAYLOAD_ITERATIONS = 200;
// Control run: every copy gets its own key and external id, so each one is a
// new effect. The checks below must then fail; if they don't, they prove nothing.
const BREAK = __ENV.BREAK_IDEMPOTENCY === '1';

export const options = {
  // http.batch defaults to 6 parallel requests per host; all copies must be in flight together.
  batch: COPIES,
  batchPerHost: COPIES,
  scenarios: {
    samePayload: {
      executor: 'shared-iterations',
      exec: 'samePayload',
      vus: 20,
      iterations: SAME_PAYLOAD_ITERATIONS,
    },
    divergentSerial: {
      executor: 'shared-iterations',
      exec: 'divergentSerial',
      vus: 5,
      iterations: 50,
    },
    divergentConcurrent: {
      executor: 'shared-iterations',
      exec: 'divergentConcurrent',
      vus: 10,
      iterations: 100,
    },
    externalIdReused: {
      executor: 'shared-iterations',
      exec: 'externalIdReused',
      vus: 5,
      iterations: 50,
    },
  },
  thresholds: idempotencyHttp,
};

export function setup() {
  healthcheck();
  return { duplicatesBefore: metricValue('wager_duplicates_total') };
}

const bet = (wallet, amount, over = {}) =>
  wagerBody(wallet, { money: money(amount), ...over });

const freshEffects = (responses) =>
  responses.filter((r) => r.status === 200 && r.json('idempotentReplay') === false);

export function samePayload() {
  const wallet = createWallet('1000.00');
  const body = bet(wallet, '10.00');
  const key = idempotencyKeyFor(body);

  const responses = http.batch(
    Array.from({ length: COPIES }, () => {
      if (!BREAK) return submitRequest(body, key);
      const own = { ...body, externalTransactionId: externalId() };
      return submitRequest(own, idempotencyKeyFor(own));
    }),
  );

  const fresh = freshEffects(responses);
  check(responses, {
    'every copy answered 200': (rs) => rs.every((r) => r.status === 200),
    'exactly one copy was a fresh effect': () => fresh.length === 1,
    'every copy points at the same transaction': (rs) =>
      new Set(rs.map((r) => r.json('transactionId'))).size === 1,
  });

  const debits = getLedger(wallet.id).filter((e) => e.direction === 'DEBIT');
  check(debits, { 'exactly one debit in the ledger': (d) => d.length === 1 });
  const balance = getWallet(wallet.id).body.balance.amount;
  check(balance, { 'balance reflects a single bet': (b) => Number(b) === 990 });
  assertReconciled([wallet.id]);
}

export function divergentSerial() {
  const wallet = createWallet('1000.00');
  const original = bet(wallet, '10.00');
  const key = idempotencyKeyFor(original);

  const first = submit(original, key);
  const conflicting = submit({ ...original, money: money('11.00') }, key);
  check(null, {
    'original bet processed': () =>
      first.status === 200 && first.json('idempotentReplay') === false,
    'same key with another payload is 409': () => conflicting.status === 409,
  });
  assertReconciled([wallet.id]);
}

export function divergentConcurrent() {
  const wallet = createWallet('1000.00');
  const original = bet(wallet, '10.00');
  const key = idempotencyKeyFor(original);
  const other = { ...original, money: money('11.00') };

  const responses = http.batch(
    Array.from({ length: COPIES }, (_, i) =>
      submitRequest(i % 2 === 0 ? original : other, key),
    ),
  );

  const fresh = freshEffects(responses);
  check(responses, {
    'no 5xx under concurrent divergent payloads': (rs) =>
      rs.every((r) => r.status === 200 || r.status === 409),
    'exactly one fresh effect': () => fresh.length === 1,
  });
  const debits = getLedger(wallet.id).filter((e) => e.direction === 'DEBIT');
  check(debits, { 'exactly one debit in the ledger': (d) => d.length === 1 });
  assertReconciled([wallet.id]);
}

export function externalIdReused() {
  const wallet = createWallet('1000.00');
  const original = bet(wallet, '10.00');

  const first = submit(original, idempotencyKeyFor(original));
  const reused = submit(original, `${idempotencyKeyFor(original)}-other`);
  check(null, {
    'original bet processed': () => first.status === 200,
    'same external id under another key is 409': () => reused.status === 409,
  });
  assertReconciled([wallet.id]);
}

export function teardown(data) {
  const duplicates = metricValue('wager_duplicates_total') - data.duplicatesBefore;
  check(duplicates, {
    'duplicates reached the application': (d) =>
      d >= SAME_PAYLOAD_ITERATIONS * (COPIES - 1),
  });
}
