# Arquitetura

> Documento vivo. Registra o que já foi decidido, o que está implementado e o que ainda está em aberto.
> Itens marcados com **(planejado)** ainda não existem no código.

## 1. Visão geral

Serviço financeiro de processamento de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com entrega
*at-least-once*, múltiplas instâncias e consistência garantida pelo banco. O enunciado completo está no
[README.md](./README.md).

Stack: Bun, TypeScript estrito, NestJS, PostgreSQL, AWS SQS (LocalStack), Docker Compose.

## 2. Estilo arquitetural

O enunciado não impõe uma arquitetura. Adotamos **camadas com inversão de dependência (hexagonal)**, porque
o enunciado exige:

- domínio sem dependência de ORM ou decorators do NestJS;
- HTTP e SQS chamando o **mesmo use case**;
- portas e fronteiras claras (critério "Modelagem e arquitetura").

### Camadas

| Camada | Responsabilidade | Pode depender de |
|---|---|---|
| `domain` | Regras e invariantes: entidades, value objects, eventos, erros | nada (TypeScript puro + `decimal.js`) |
| `application` | Use cases e **portas** (repositórios, unit of work, publisher, clock) | `domain` |
| `infrastructure` | Adapters de saída: ORM, SQS, auth | `application`, `domain` |
| `interface` | Adapters de entrada: controllers HTTP, consumer SQS, workers agendados, health | `application` |

```
interface ──► application ──► domain
                  ▲
infrastructure ───┘ (implementa as portas)
```

A composição (qual adapter implementa qual porta) acontece só no `app.module.ts`.

### Estrutura de pastas

```
src/
├── domain/
│   ├── errors/        DomainError e erros específicos
│   ├── shared/        backoff exponencial
│   ├── money/         Money
│   ├── wallet/        Wallet
│   ├── ledger/        WalletLedgerEntry, LedgerDirection
│   ├── wagering/      WagerTransaction, Kind, Status, FailureCode
│   ├── messaging/     InboxMessage, OutboxMessage
│   └── events/        IntegrationEvent e os 4 eventos concretos
├── application/       (planejado) use-cases/ e ports/
├── infrastructure/    (planejado) persistence/, messaging/sqs/, auth/
└── interface/         (planejado) http/, sqs/, workers/, health/
```

Convenção dentro de cada módulo de domínio: `model/` (classes), `dtos/` (props e state), `enums/`. Os testes
ficam ao lado da classe (`Classe.spec.ts`).

## 3. Domínio ≠ ORM

As classes de `domain` **não são entidades do ORM**. Têm identidade e comportamento (são entidades no sentido
de DDD), mas não carregam decorators nem imports de persistência.

- O mapeamento para tabelas fica em `infrastructure/persistence` **(planejado)**, com schemas separados e
  *mappers* que reconstroem o domínio via `rehydrate`.
- Trocar o ORM afeta só `infrastructure`.
- Construtores são `private`; a criação passa por factories estáticas (`from`, `create`, `open`, `receive`,
  `enqueue`, `rehydrate`), então nenhum objeto inválido nasce pela API pública.
- `rehydrate` reconstrói estado já persistido e **não revalida** regras de transição.

## 4. Estado atual da implementação

### Implementado

- **Modelo de domínio completo** (seção 5): `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`,
  `InboxMessage`, `OutboxMessage`, `IntegrationEvent` com 4 eventos e a taxonomia de `FailureCode`.
- **Testes unitários** de todas as classes de domínio (Vitest).
- **Infra local**: `docker-compose.yml` com PostgreSQL 17 e LocalStack 3.8.1 (somente SQS).
- **Filas SQS**: `wager-transactions.fifo` e `wager-transactions-dlq.fifo` criadas por
  `docker/localstack/init-sqs.sh`.

### Pendente

Use cases, portas, persistência (ORM, schema, migrations), API HTTP, consumer SQS, workers (outbox e
`PENDING_REFERENCE`), reconciliação, observabilidade, testes de integração e de concorrência.

## 5. Modelo de domínio

### 5.1 Money

Value object imutável. Decisões:

- **`Decimal.js`** para o valor interno, nunca `number`. Usamos `Decimal.clone({ precision: 40 })` para isolar a
  configuração e garantir que somas e subtrações de valores com 2 casas nunca arredondem.
- **Escala fixa de 2 casas** na saída (`toFixed(2)`).
- **Validação em `from()`**, antes de construir o `Decimal` (que aceitaria `NaN`, `Infinity` e `1e3`):
  - `amount`: `/^\d+(\.\d{1,2})?$/`: sem sinal, sem expoente, no máximo 2 casas. `"25"` e `"25.5"` são aceitos e
    normalizados para `25.00` e `25.50`. Mais de 2 casas é rejeitado, nunca arredondado;
  - `currency`: `/^[A-Z]{3}$/` (formato ISO-4217).
- **Negativos**: `from()` rejeita (contrato de entrada), mas `subtract` e `negate` produzem negativos
  internamente. Eles usam o construtor privado, que não valida.
- **Zero negativo**: `Decimal` preserva `-0`, então `isNegative()` retornaria `true` e `toFixed(2)` retornaria
  `"-0.00"`. O construtor normaliza `-0` para `0`.
- **Moedas diferentes**: `add`, `subtract` e `isLessThan` lançam `CurrencyMismatchError`. `equals` retorna
  `false`, pois uma comparação de igualdade não deve lançar erro.
- **Persistência (planejado)**: colunas `numeric(20,2)` + `char(3)`, lidas e gravadas como **string**, nunca
  como `number`.

### 5.2 Wallet (aggregate root)

- `Wallet.open()` cria a wallet com `version = 1`. Se o saldo inicial for positivo, devolve também o
  lançamento `OPENING` (`{ wallet, openingEntry }`), e os ids dele são obrigatórios. Saldo inicial negativo é
  rejeitado.
- `debit()` e `credit()` aplicam a movimentação **e devolvem o `WalletLedgerEntry` correspondente**, então saldo
  e ledger mudam sempre juntos. O lançamento é criado antes de alterar qualquer estado: se algo falhar (saldo
  insuficiente, moeda diferente, valor não positivo), a wallet permanece intacta.
- `version` incrementa **somente** quando o saldo muda, e `updatedAt` acompanha.
- Saldo nunca fica negativo: `debit` lança `InsufficientFundsError`. O use case traduz o erro para o
  `FailureCode` correto.
- A unicidade `playerId + currency` e a não-negatividade também serão garantidas no banco **(planejado)**.

### 5.3 WalletLedgerEntry (imutável)

- Todos os campos são `readonly` e o objeto é congelado com `Object.freeze` (imutabilidade estrutural, também em
  runtime). Não há métodos de transição.
- `create()` valida: valor positivo, saldos não negativos, mesma moeda nos três valores e
  `balanceBefore ± money === balanceAfter`. `isBalanced()` repete a verificação para uso em reconciliação.
- `LOSS` e transações `REJECTED` não geram lançamento.

### 5.4 WagerTransaction

Estados e transições (`PROCESSED`, `REJECTED` e `FAILED` são terminais):

```
                 ┌──► PROCESSED
PENDING ─────────┼──► REJECTED
   │             └──► FAILED
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

Transicionar a partir de um estado terminal (ou qualquer transição fora da tabela) lança
`InvalidTransactionStateError`: é erro de programação, não caminho de negócio.

**Criação**

- `create()` é a factory exposta ao provedor e **recusa `OPENING`**. O crédito de abertura nasce em
  `WagerTransaction.opening()`, com `providerId = "__internal__"` e `externalTransactionId = "opening:<walletId>"`,
  o que garante uma abertura por wallet pela constraint de unicidade.
- Validações: campos de texto obrigatórios, valor positivo, `referenceExternalTransactionId` obrigatório em
  `REFUND` e `ROLLBACK`, e proibido em `BET`.

**Direção do ledger** (`ledgerDirectionFor`)

| Kind | Direção |
|---|---|
| `BET` | `DEBIT` |
| `WIN`, `REFUND`, `OPENING` | `CREDIT` |
| `ROLLBACK` | inversa da referência (`BET` → `CREDIT`; `WIN` e `REFUND` → `DEBIT`) |
| `LOSS` | sem lançamento (lança erro se consultado) |

**Referências** (`checkReference`)

A referência é resolvida por `(providerId, referenceExternalTransactionId)`. `checkReference()` devolve o
`FailureCode` da violação ou `undefined` quando válida:

| Kind | Pode referenciar |
|---|---|
| `BET`, `OPENING` | nada |
| `WIN`, `LOSS` | `BET` (opcional) |
| `REFUND` | `BET` |
| `ROLLBACK` | `BET`, `WIN` ou `REFUND` |

Também valida mesmo provider, player, wallet, moeda e rodada; que a referência esteja `PROCESSED`; e, em
`REFUND`/`ROLLBACK`, que o valor seja **igual** ao da referência. A checagem de "já revertida" exige consulta e
fica no use case, reforçada por um índice único parcial por `(referenceTransactionId, kind)` **(planejado)**.

**Referência fora de ordem**

`markPendingReference(now)` guarda a transação e agenda a primeira nova tentativa. `scheduleReferenceRetry(now)`
incrementa `referenceAttempts` e calcula `nextReferenceAttemptAt` com backoff exponencial.
`isReferenceRetryDue(now)` diz se o worker deve reprocessar. O limite de tentativas é política do use case: ao
esgotar, a transação é `REJECTED` com `REFERENCE_NOT_FOUND` e o evento correspondente é publicado.

### 5.5 FailureCode

Código estável e legível por máquina em toda rejeição, para o provedor decidir se reenvia, corrige o payload ou
desiste:

| Código | Quando | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | desistir / aguardar o jogador |
| `REVERSAL_WOULD_OVERDRAW` | `REFUND`/`ROLLBACK` deixaria o saldo negativo | desistir / tratar manualmente |
| `ALREADY_REVERSED` | referência já revertida pelo mesmo tipo de operação | desistir |
| `REFERENCE_NOT_FOUND` | referência não chegou após esgotar as tentativas | enviar a referência e reenviar |
| `REFERENCE_MISMATCH` | provider, player, wallet, moeda ou rodada diferentes | corrigir o payload |
| `INVALID_REFERENCE_KIND` | tipo de referência não permitido (ex.: `REFUND` de um `WIN`) | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência existe, mas foi rejeitada ou falhou | desistir |
| `AMOUNT_MISMATCH` | valor difere do valor da referência | corrigir o payload |
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | wallet não pertence ao player | corrigir o payload |
| `CURRENCY_MISMATCH` | moeda da operação difere da wallet | corrigir o payload |
| `INTERNAL_ERROR` | erro permanente de infraestrutura (`FAILED`) | investigação do operador |

`INSUFFICIENT_FUNDS` e `REVERSAL_WOULD_OVERDRAW` são distintos de propósito (regra 9 do enunciado). O método
`overdrawFailureCode()` escolhe entre eles conforme o `kind`.

### 5.6 Inbox e Outbox

- `InboxMessage`: `receive()` valida `messageId` e `consumerName`; `markProcessed()` lança erro se já processada.
  A deduplicação será pela chave `(consumerName, messageId)` no banco **(planejado)**.
- `OutboxMessage`: `enqueue(event)` copia o envelope (`event.toJSON()`) e usa o **`eventId` como id**, então
  reenfileirar o mesmo evento não cria uma segunda linha. `isDue(now)` considera `nextAttemptAt`;
  `scheduleRetry(now)` incrementa `attempts` e aplica backoff; `markPublished(at)` encerra o ciclo e lança erro
  se chamado de novo.

### 5.7 Eventos de integração

`IntegrationEvent<T>` é uma classe abstrata (envelope com `eventId`, `aggregateId`, `correlationId`,
`causationId`, `occurredAt`, `eventType`, `version`, `data`). Cada evento é uma subclasse com `eventType` e
`version` **no tipo**:

| Evento | `aggregateId` | Quando |
|---|---|---|
| `WagerTransactionProcessed` | transação | qualquer transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | transação | rejeição por regra de negócio (carrega o `failureCode`) |
| `WalletBalanceChanged` | wallet | somente quando o saldo muda |
| `WagerTransactionPendingReference` | transação | referência ausente |

`data` carrega `MoneyProps` (string decimal), nunca instâncias de `Money`. As factories `from()` validam o estado
da transação (ex.: `WagerTransactionRejected.from` exige `REJECTED` com `failureCode`). Em `WalletBalanceChanged`,
a wallet passada já deve refletir a movimentação, pois `walletVersion` vem dela.

### 5.8 Backoff

`backoffUntil(attempts, now)`: `1s * 2^attempts`, com teto de 5 minutos. É determinístico, sem jitter, para ser
testável. É compartilhado pela outbox e pelo `PENDING_REFERENCE`.

## 6. Interpretações adicionais do enunciado

O enunciado pede que interpretações adicionais sejam documentadas:

- Toda transação exige **valor positivo**, inclusive `WIN` e `LOSS`.
- `BET` não aceita referência. `WIN` e `LOSS` aceitam uma referência opcional a `BET`.
- `ROLLBACK` não pode referenciar `LOSS`, `OPENING` nem outro `ROLLBACK`.
- A referência precisa estar `PROCESSED` para ser revertida ou usada.
- Wallet aberta com saldo zero não gera `OPENING` nem lançamento.
- O limite de tentativas do `PENDING_REFERENCE` e o `maxReceiveCount` da fila ainda não estão definidos.

## 7. Infraestrutura local

```bash
docker compose up -d
```

| Serviço | Imagem | Porta |
|---|---|---|
| `postgres` | `postgres:17-alpine` | 5432 |
| `localstack` | `localstack/localstack:3.8.1` | 4566 |

- A versão do LocalStack está **fixa**: as tags mais recentes exigem `LOCALSTACK_AUTH_TOKEN`.
- `maxReceiveCount=5` na redrive policy da fila principal é um valor inicial, a revisar junto com a política de
  retry.
- As filas usam `ContentBasedDeduplication=true` por conveniência em dev. **A garantia de idempotência vem da
  inbox no banco**, não do SQS FIFO (restrição inviolável nº 3 do enunciado).
- Variáveis de ambiente: ver `.env.example`.

## 8. Como trabalhamos

- **Commits** em inglês, no padrão Conventional Commits (`feat`, `fix`, `test`, `docs`, `build`, `chore`,
  `style`), pequenos e focados, um arquivo por commit.
- **Qualidade antes de commitar**: `prettier`, `oxlint`, `tsc --noEmit` e `vitest` limpos.
- **Testes** unitários acompanham cada classe de domínio. Integração e concorrência usarão PostgreSQL e SQS
  reais em containers, como pede o enunciado.
- **Invariantes no banco**: unicidade, imutabilidade do ledger e não-negatividade do saldo serão aplicadas por
  constraints e triggers nas migrations, não só em código.

## 9. Decisões em aberto

| Tema | Situação |
|---|---|
| ORM | MikroORM (preferencial no enunciado) ainda não instalado; justificar a escolha e o mapeamento do `Money` |
| Estratégia de concorrência | `SELECT ... FOR UPDATE` na wallet, optimistic locking ou update atômico |
| Publicação da outbox | `FOR UPDATE SKIP LOCKED` para múltiplos publishers |
| Mapeamento de status HTTP | a definir (inválido, conflito de idempotência, rejeição de negócio, pendente, falha transitória) |
| Hash do `payloadHash` | JSON canônico (chaves ordenadas) do subconjunto de negócio; algoritmo a documentar |
| Limite de tentativas / TTL de `PENDING_REFERENCE` | a definir e justificar (o backoff já existe) |
| Autenticação | opcional; se não implementada, documentar e deixar ponto de extensão (`AuthPort`) |

## 10. Limitações conhecidas

A preencher conforme a implementação avançar.
