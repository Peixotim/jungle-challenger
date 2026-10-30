import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, PROVIDER_ID } from './config.js';
import {
  createWallet,
  externalId,
  idempotencyKeyFor,
  money,
  submit,
  wagerBody,
} from './api.js';

const RICH_BALANCE = '1000000.00';
const POOR_BALANCE = '1.00';
const POOR_BET_SHARE = 0.02;

// Per-VU state: bets this VU placed and has not settled or reversed yet.
const openBets = [];
let lastExternalId;

export function createFleet(count, poorCount = 1) {
  return {
    rich: Array.from({ length: count }, () => createWallet(RICH_BALANCE)),
    poor: Array.from({ length: poorCount }, () => createWallet(POOR_BALANCE)),
  };
}

export function allWalletIds(fleet) {
  return [...fleet.rich, ...fleet.poor].map((w) => w.id);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function send(body, accepted, name) {
  const response = submit(body, idempotencyKeyFor(body), {
    tags: { op: name },
  });
  check(response, {
    [`${name} status is expected`]: (r) => accepted.includes(r.status),
  });
  return response;
}

function placeBet(fleet) {
  const wallet = pick(fleet.rich);
  const body = wagerBody(wallet, {
    roundId: `round-${externalId()}`,
    money: money((1 + Math.floor(Math.random() * 25)).toFixed(2)),
  });
  const response = send(body, [200], 'BET');
  lastExternalId = body.externalTransactionId;
  if (response.status === 200) openBets.push({ body, wallet });
}

// 422 is the expected outcome: the poor wallet cannot cover a 25.00 bet.
function placeUnaffordableBet(fleet) {
  const body = wagerBody(pick(fleet.poor), {
    roundId: `round-${externalId()}`,
    money: money('25.00'),
  });
  send(body, [422], 'BET_POOR');
}

function settleBet(fleet) {
  const bet = openBets.pop();
  if (!bet) return placeBet(fleet);
  const kind = Math.random() < 0.5 ? 'WIN' : 'LOSS';
  const body = wagerBody(bet.wallet, {
    kind,
    roundId: bet.body.roundId,
    money: money('2.00'),
    referenceExternalTransactionId: bet.body.externalTransactionId,
  });
  send(body, [200], kind);
}

// Each bet is settled or reversed once and was processed (200), so 200 is the only correct answer.
function reverseBet(fleet) {
  const bet = openBets.pop();
  if (!bet) return placeBet(fleet);
  const kind = Math.random() < 0.5 ? 'REFUND' : 'ROLLBACK';
  const body = wagerBody(bet.wallet, {
    kind,
    roundId: bet.body.roundId,
    money: bet.body.money,
    referenceExternalTransactionId: bet.body.externalTransactionId,
  });
  send(body, [200], kind);
}

function read(fleet) {
  const wallet = pick(fleet.rich);
  const reads = [
    `${BASE_URL}/wallets/${wallet.id}`,
    `${BASE_URL}/wallets/${wallet.id}/ledger?limit=20`,
  ];
  if (lastExternalId) {
    reads.push(
      `${BASE_URL}/providers/${PROVIDER_ID}/wagering/transactions/${lastExternalId}`,
    );
  }
  const response = http.get(pick(reads), { tags: { op: 'READ' } });
  check(response, { 'READ status is expected': (r) => r.status === 200 });
}

// 60% BET, 20% WIN/LOSS, 5% REFUND/ROLLBACK, 15% reads.
export function runOperation(fleet) {
  const roll = Math.random() * 100;
  if (roll < 60) {
    if (Math.random() < POOR_BET_SHARE) placeUnaffordableBet(fleet);
    else placeBet(fleet);
  } else if (roll < 80) settleBet(fleet);
  else if (roll < 85) reverseBet(fleet);
  else read(fleet);
}
