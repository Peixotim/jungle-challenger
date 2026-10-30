import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { LedgerDirection } from '../../../domain/ledger/enums/LedgerDirection.js';
import { FailureCode } from '../../../domain/wagering/enums/FailureCode.js';
import { WagerTransactionKind } from '../../../domain/wagering/enums/WagerTransactionKind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/enums/WagerTransactionStatus.js';
import {
  createWalletBody,
  submitTransactionBody,
} from '../validation/schemas.js';

type Schema = Record<string, unknown>;

// Request bodies come from the zod schemas that validate them, so the contract cannot drift.
function bodySchema(schema: z.ZodType): Schema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    target: 'openapi-3.0',
  });
  return rest;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ 'application/json': { schema } });
const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
});

const PLAYER_ID = '0b9b6d5e-3d1f-4c9a-9d0e-5a1f2f6c7a11';
const WALLET_ID = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const walletIdParam = {
  name: 'walletId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'The id returned by `POST /wallets`.',
};

const idempotencyKeyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', pattern: '^[\\x21-\\x7e]{1,255}$' },
  description:
    '1 to 255 printable characters, no spaces. Retrying with the same key and payload replays the first result ' +
    '(`idempotentReplay: true`); the same key with a different payload is a 409.',
  example: 'bet-0001',
};

const money: Schema = {
  type: 'object',
  required: ['amount', 'currency'],
  properties: {
    amount: {
      type: 'string',
      pattern: '^\\d+(\\.\\d{1,2})?$',
      example: '10.00',
      description: 'Decimal string with up to 2 fraction digits.',
    },
    currency: {
      type: 'string',
      pattern: '^[A-Z]{3}$',
      example: 'BRL',
    },
  },
};

const enumOf = (values: object) => ({
  type: 'string',
  enum: Object.values(values),
});
const uuid = { type: 'string', format: 'uuid' };
const dateTime = { type: 'string', format: 'date-time' };

const schemas: Record<string, Schema> = {
  Money: money,
  Wallet: {
    type: 'object',
    required: ['id', 'playerId', 'balance', 'version'],
    properties: {
      id: uuid,
      playerId: uuid,
      balance: ref('Money'),
      version: { type: 'integer' },
    },
  },
  LedgerEntry: {
    type: 'object',
    required: [
      'id',
      'transactionId',
      'direction',
      'money',
      'balanceBefore',
      'balanceAfter',
      'createdAt',
    ],
    properties: {
      id: uuid,
      transactionId: uuid,
      direction: enumOf(LedgerDirection),
      money: ref('Money'),
      balanceBefore: ref('Money'),
      balanceAfter: ref('Money'),
      createdAt: dateTime,
    },
  },
  LedgerPage: {
    type: 'object',
    required: ['entries'],
    properties: {
      entries: { type: 'array', items: ref('LedgerEntry') },
      nextCursor: {
        type: 'string',
        description:
          'Pass as `cursor` to fetch the next page. Absent on the last page.',
      },
    },
  },
  Reconciliation: {
    type: 'object',
    required: [
      'walletId',
      'storedBalance',
      'calculatedBalance',
      'difference',
      'consistent',
      'checkedEntries',
    ],
    properties: {
      walletId: uuid,
      storedBalance: ref('Money'),
      calculatedBalance: ref('Money'),
      difference: ref('Money'),
      consistent: { type: 'boolean' },
      checkedEntries: { type: 'integer' },
    },
  },
  SubmitResult: {
    type: 'object',
    required: ['transactionId', 'status', 'idempotentReplay'],
    properties: {
      transactionId: uuid,
      status: enumOf(WagerTransactionStatus),
      balance: ref('Money'),
      failureCode: enumOf(FailureCode),
      idempotentReplay: { type: 'boolean' },
    },
  },
  WagerTransaction: {
    type: 'object',
    required: [
      'transactionId',
      'providerId',
      'externalTransactionId',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
      'kind',
      'money',
      'status',
      'createdAt',
    ],
    properties: {
      transactionId: uuid,
      providerId: { type: 'string' },
      externalTransactionId: { type: 'string' },
      walletId: uuid,
      playerId: uuid,
      roundId: { type: 'string' },
      gameId: { type: 'string' },
      kind: enumOf(WagerTransactionKind),
      money: ref('Money'),
      status: enumOf(WagerTransactionStatus),
      referenceExternalTransactionId: { type: 'string' },
      failureCode: enumOf(FailureCode),
      balance: ref('Money'),
      createdAt: dateTime,
      processedAt: dateTime,
    },
  },
  Problem: {
    type: 'object',
    required: ['type', 'title', 'status', 'code'],
    properties: {
      type: { type: 'string', example: 'about:blank' },
      title: { type: 'string', example: 'Bad Request' },
      status: { type: 'integer', example: 400 },
      code: { type: 'string', example: 'VALIDATION_ERROR' },
      detail: { type: 'string' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
      correlationId: { type: 'string' },
    },
  },
};

const submitExample = {
  providerId: 'provider-1',
  externalTransactionId: 'ext-bet-0001',
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};

export function buildOpenApiDocument(): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Wagering Processor API',
      version: '1.0.0',
      description:
        'Wallets and wagering transactions (BET, WIN, LOSS, REFUND, ROLLBACK).\n\n' +
        '**Quick start:** 1) `POST /wallets` with a fresh `playerId`; 2) copy the returned `id` and use it as ' +
        '`walletId` (with the same `playerId`) in `POST /wagering/transactions`; 3) check `GET /wallets/{walletId}`, ' +
        '`/ledger` and `POST /wallets/{walletId}/reconciliation`.\n\n' +
        'Errors use `application/problem+json`. Transactions are idempotent by `Idempotency-Key`.',
    },
    tags: [{ name: 'Wallets' }, { name: 'Wagering' }, { name: 'Operations' }],
    paths: {
      '/wallets': {
        post: {
          tags: ['Wallets'],
          summary: 'Create a wallet with an initial balance',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: bodySchema(createWalletBody),
                example: {
                  playerId: PLAYER_ID,
                  initialBalance: { amount: '1000.00', currency: 'BRL' },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Wallet created.',
              content: json(ref('Wallet')),
            },
            '400': problem('Invalid body or amount.'),
            '409': problem(
              '`WALLET_ALREADY_EXISTS`: that player already has a wallet in that currency.',
            ),
          },
        },
      },
      '/wallets/{walletId}': {
        get: {
          tags: ['Wallets'],
          summary: 'Get a wallet and its current balance',
          parameters: [walletIdParam],
          responses: {
            '200': { description: 'The wallet.', content: json(ref('Wallet')) },
            '404': problem('`WALLET_NOT_FOUND`.'),
          },
        },
      },
      '/wallets/{walletId}/ledger': {
        get: {
          tags: ['Wallets'],
          summary: 'List ledger entries, oldest first, with cursor paging',
          parameters: [
            walletIdParam,
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string', minLength: 1, maxLength: 512 },
              description: 'The `nextCursor` of the previous page.',
            },
          ],
          responses: {
            '200': {
              description: 'A page of entries.',
              content: json(ref('LedgerPage')),
            },
            '400': problem('Invalid `limit` or `cursor`.'),
            '404': problem('`WALLET_NOT_FOUND`.'),
          },
        },
      },
      '/wallets/{walletId}/reconciliation': {
        post: {
          tags: ['Wallets'],
          summary:
            'Recompute the balance from the ledger and compare it with the stored one',
          parameters: [walletIdParam],
          responses: {
            '200': {
              description:
                'The comparison; `consistent` is false when they differ.',
              content: json(ref('Reconciliation')),
            },
            '404': problem('`WALLET_NOT_FOUND`.'),
          },
        },
      },
      '/wagering/transactions': {
        post: {
          tags: ['Wagering'],
          summary: 'Submit a wagering transaction (idempotent)',
          description:
            '`WIN`, `LOSS`, `REFUND` and `ROLLBACK` must set `referenceExternalTransactionId` to the ' +
            '`externalTransactionId` of the original `BET`. The HTTP status mirrors the outcome.',
          parameters: [idempotencyKeyParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: bodySchema(submitTransactionBody),
                example: submitExample,
              },
            },
          },
          responses: {
            '200': {
              description: '`PROCESSED`, or a replay of a processed request.',
              content: json(ref('SubmitResult')),
            },
            '202': {
              description:
                '`PENDING` or `PENDING_REFERENCE`: accepted, the referenced transaction has not arrived yet.',
              content: json(ref('SubmitResult')),
            },
            '400': problem('Invalid body, header or money.'),
            '409': problem(
              '`IDEMPOTENCY_PAYLOAD_MISMATCH` or `IDEMPOTENCY_EXTERNAL_ID_REUSED`.',
            ),
            '422': {
              description:
                '`REJECTED`: a business rule failed, see `failureCode` (e.g. `INSUFFICIENT_FUNDS`).',
              content: json(ref('SubmitResult')),
            },
            '503': problem(
              '`TEMPORARILY_UNAVAILABLE`: retry with the same `Idempotency-Key`.',
            ),
          },
        },
      },
      '/wagering/transactions/{transactionId}': {
        get: {
          tags: ['Wagering'],
          summary: 'Get a transaction by internal id',
          parameters: [
            {
              name: 'transactionId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'The transaction.',
              content: json(ref('WagerTransaction')),
            },
            '404': problem('`TRANSACTION_NOT_FOUND`.'),
          },
        },
      },
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
        get: {
          tags: ['Wagering'],
          summary: "Get a transaction by the provider's own id",
          parameters: [
            {
              name: 'providerId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              example: 'provider-1',
            },
            {
              name: 'externalTransactionId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              example: 'ext-bet-0001',
            },
          ],
          responses: {
            '200': {
              description: 'The transaction.',
              content: json(ref('WagerTransaction')),
            },
            '404': problem('`TRANSACTION_NOT_FOUND`.'),
          },
        },
      },
      '/health/live': {
        get: {
          tags: ['Operations'],
          summary: 'Liveness probe',
          responses: { '200': { description: '`{ "status": "up" }`.' } },
        },
      },
      '/health/ready': {
        get: {
          tags: ['Operations'],
          summary: 'Readiness probe: database and SQS',
          responses: {
            '200': { description: 'All checks are up.' },
            '503': {
              description: 'A check is down or the service is shutting down.',
            },
          },
        },
      },
      '/metrics': {
        get: {
          tags: ['Operations'],
          summary: 'Prometheus metrics',
          responses: {
            '200': {
              description: 'Prometheus text format.',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
    },
    components: { schemas },
  } as OpenAPIObject;
}
