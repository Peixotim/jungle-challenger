# Arquitetura

> Documento vivo. Registra as decisões, os trade-offs e as limitações do serviço. O que ainda está pendente fica
> na seção 14.

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
├── application/
│   ├── ports/         contratos (repositórios, UnitOfWork, publisher, clock, ids, log, métricas)
│   ├── use-cases/     casos de uso
│   ├── services/      WagerTransactionProcessor
│   ├── idempotency/   payload-hash
│   ├── dtos/          comandos, resultados e views
│   ├── mappers/       domínio para views
│   └── errors/        erros de aplicação
├── infrastructure/
│   ├── persistence/   mikro-orm.config, UnitOfWork, repositories/, mappers/, migrations/
│   ├── observability/ JsonLogger, PrometheusMetrics, request-context
│   ├── lifecycle/     LifecycleState
│   ├── system/        SystemClock, UuidV7Generator
│   └── messaging/sqs/ cliente, SqsEventPublisher, SqsHealthIndicator
├── interface/
│   ├── http/          controllers/, validation/ (Zod), middleware/, filters/, auth/, presenters/,
│   │                  problem e error-mapping
│   ├── sqs/           SqsConsumer, WagerMessageHandler, schemas, runner de ciclo de vida
│   └── workers/       PeriodicTask e WorkerRunner
├── modules/           módulos NestJS que compõem as camadas (composição)
├── config/            configuração tipada, validada e carregada do ambiente
├── bootstrap/         configure-app e encerramento gracioso
├── app.module.ts
└── main.ts
```

Convenção dentro de cada módulo de domínio: `model/` (classes), `dtos/` (props e state), `enums/`.

Os testes ficam fora de `src/`, em `test/`, espelhando a estrutura de `src/`: por exemplo, `Money` fica em
`src/domain/money/model/Money.ts` e seu teste em `test/domain/money/Money.spec.ts`. Testes de integração
(`test/integration/`, banco e SQS reais) e e2e (`test/*.e2e-spec.ts`) seguem o mesmo princípio.

## 3. Domínio ≠ ORM

As classes de `domain` **não são entidades do ORM**. Têm identidade e comportamento (são entidades no sentido
de DDD), mas não carregam decorators nem imports de persistência.

- O mapeamento para tabelas fica em `infrastructure/persistence`, com *mappers* explícitos que reconstroem o
  domínio via `rehydrate`.
- Trocar o ORM afeta só `infrastructure`.
- Construtores são `private`; a criação passa por factories estáticas (`from`, `create`, `open`, `receive`,
  `enqueue`, `rehydrate`), então nenhum objeto inválido nasce pela API pública.
- `rehydrate` reconstrói estado já persistido e **não revalida** regras de transição.

## 4. Estado atual da implementação

### Implementado

- **Modelo de domínio completo** (seção 5): `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`,
  `InboxMessage`, `OutboxMessage`, `IntegrationEvent` com 4 eventos e a taxonomia de `FailureCode`.
- **Camada `application`** (seção 6): portas, `SubmitWagerTransaction` (com idempotência), `CreateWallet`,
  `ReprocessPendingReferences`, `PublishOutbox`, `ReconcileWallet` e as consultas.
- **Persistência** (seção 7): schema com constraints e triggers, migrations reversíveis, Unit of Work e
  repositórios sobre MikroORM e PostgreSQL.
- **Bootstrap e operação** (seção 8): configuração validada, `main.ts` e `AppModule` completos, logs JSON com
  correlation id, métricas Prometheus, erros `problem+json`, verificação de migrations no start e encerramento
  gracioso.
- **API HTTP** (seção 9): todos os endpoints do enunciado, validação estrita, mapeamento único de status,
  `/health/live`, `/health/ready` e `/metrics`.
- **Testes unitários** de todas as classes de domínio, de todos os use cases e das camadas de bootstrap e HTTP (Vitest).
- **Testes de integração** contra PostgreSQL real: migrations, constraints, idempotência, concorrência,
  atomicidade, referências fora de ordem e outbox.
- **Testes e2e** (`bun run test:e2e`) que sobem o `AppModule` inteiro contra o banco real e exercitam a API por
  HTTP: contratos, status, idempotência concorrente, saldo, rejeições, métricas, readiness e uma queda real do
  banco (um proxy TCP entre o app e o PostgreSQL é cortado e restaurado; a API responde `503` e se recupera).
- **Mensageria e workers** (seção 10): consumer SQS com inbox, `ack` após o commit, retry com backoff e DLQ;
  publisher da outbox; workers de outbox e de `PENDING_REFERENCE`; health do SQS.
- **Testes com SQS real e com 3 processos reais** (seção 10.7), incluindo um processo morto com `SIGKILL`.
- **Infra local**: `docker-compose.yml` com PostgreSQL 17 e LocalStack 3.8.1 (somente SQS), e as três filas
  criadas por `docker/localstack/init-sqs.sh`.

### Pendente

`README.md` de setup, teste de carga opcional e autenticação com IdP (seção 14).

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
- **Persistência**: colunas `numeric(20,2)` + `char(3)`, lidas e gravadas como **string**, nunca
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
- A unicidade `playerId + currency` e a não-negatividade também são garantidas no banco (seção 7.5).

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
fica no use case, reforçada por um índice único parcial por `(referenceTransactionId, kind)`.

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
  A deduplicação é pela chave `(consumerName, messageId)` no banco.
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

## 6. Camada application

### 6.1 Portas

Classes abstratas em `application/ports/` (servem de token de DI sem decorators): `UnitOfWork` (abre **uma**
transação SQL e entrega os repositórios ligados a ela), `WalletRepository`, `WagerTransactionRepository`,
`LedgerRepository`, `InboxRepository`, `OutboxRepository`, `EventPublisher`, `Clock`, `IdGenerator`, `Logger` e
`Metrics`. Os use cases não têm decorators do NestJS; a ligação ocorre no módulo, por factories.

### 6.2 Use cases

| Use case | Papel |
|---|---|
| `SubmitWagerTransaction` | porta de entrada única de HTTP e SQS; idempotência e aplicação do movimento |
| `CreateWallet` | abre a wallet; saldo positivo gera `OPENING`, lançamento e eventos na mesma transação |
| `ReprocessPendingReferences` | tick do worker: retenta `PENDING_REFERENCE` com backoff |
| `PublishOutbox` | tick do worker: publica a outbox |
| `ReconcileWallet` | compara saldo armazenado × ledger |
| `GetWallet`, `GetWalletLedger`, `GetWagerTransaction` | consultas |

`WagerTransactionProcessor` concentra a decisão e a aplicação do resultado de uma transação (lock da wallet,
validação de referência, movimento, eventos). É usado tanto pela primeira tentativa quanto pelas retentativas,
então as duas seguem as mesmas regras.

### 6.3 Idempotência

A unicidade é decidida **pelo banco**, nunca por leitura seguida de escrita:

1. O `payloadHash` é o SHA-256 (hex) do JSON canônico (chaves ordenadas em todos os níveis, `undefined`
   descartado) apenas dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`,
   `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. Header, `messageId`, `occurredAt` e
   `correlationId` ficam de fora. `money` entra via `toJSON()`, então `"25"` e `"25.00"` geram o mesmo hash.
2. `insertIfAbsent` insere a transação candidata, apoiado nos índices únicos `idempotency_key` e
   `(provider_id, external_transaction_id)`. Se outra transação concorrente está inserindo a mesma chave, o
   `INSERT` **espera** o desfecho dela: ninguém observa uma linha meio processada.
3. Quem **inseriu** aplica o movimento. Quem encontrou uma linha existente responde:
   - mesma chave e mesmo hash: **replay**, `idempotentReplay: true`, com o saldo observado originalmente
     (`observedBalance` na transação), não o saldo atual;
   - mesma chave e hash diferente: `IdempotencyConflictError(PAYLOAD_MISMATCH)`;
   - mesmo `externalTransactionId` com outra chave: `IdempotencyConflictError(EXTERNAL_ID_REUSED)`.
4. Como a linha da transação e o movimento confirmam na mesma transação SQL, uma linha confirmada está sempre no
   estado final (`PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`).
5. Mensagens SQS passam antes pela **inbox** `(consumerName, messageId)`. Uma redelivery cai no caminho de
   replay. A inbox é gravada na mesma transação, então só existe se o processamento confirmou.

### 6.4 Referência fora de ordem

Referência ausente (ou ainda pendente) coloca a transação em `PENDING_REFERENCE`. O worker retenta com backoff
exponencial (1s, 2s, 4s... teto de 5min) até **10 retentativas** (~18min no total); esgotado, a transação é
`REJECTED` com `REFERENCE_NOT_FOUND` e o evento `WagerTransactionRejected` é publicado. A janela cobre o
desordenamento normal de um provedor e ainda expõe uma referência realmente perdida. Os workers usam
`FOR UPDATE SKIP LOCKED` (uma transação por item), então várias instâncias convivem sem se atrapalhar.

### 6.5 Outbox e reconciliação

- `PublishOutbox` reivindica um lote de mensagens vencidas com `FOR UPDATE SKIP LOCKED` (publishers concorrentes
  pegam lotes disjuntos). Falha ao publicar chama `scheduleRetry` (backoff) e não perde a mensagem. A entrega é
  *at-least-once*: se o processo morre depois do broker aceitar e antes do commit, outro publisher reenvia, e o
  consumidor deduplica pelo `eventId`.
- `ReconcileWallet` trava a wallet, soma o ledger no banco e compara. Divergência é logada (`error`), contada
  (`wallet_reconciliations_total{result="divergent"}`) e devolvida na resposta, **nunca corrigida**.
- Métricas já emitidas pelos use cases: `wager_reference_retries_total`, `outbox_lag_seconds`,
  `outbox_publish_failures_total` e `wallet_reconciliations_total`. As demais (transações por status, duplicatas,
  DLQ, conflitos de lock, latência) entram com os adapters.

## 7. Persistência

### 7.1 ORM e estratégia transacional

**MikroORM 7 + PostgreSQL.** O ORM entrega o pool de conexões, o `Migrator` e o
`EntityManager.transactional()`, que é a nossa Unit of Work: cada `UnitOfWork.run` abre **uma** transação SQL
(em um `fork()` do `EntityManager`, isolamento `READ COMMITTED`) e entrega os repositórios ligados a ela.

**Não há entidades mapeadas.** O domínio não é entidade do ORM (seção 3), e as garantias do desafio dependem de
construtos SQL que um mapeamento declarativo não expressa: índices únicos parciais, triggers, `ON CONFLICT` e
`FOR UPDATE SKIP LOCKED`. Os repositórios usam `em.execute` com SQL parametrizado e *mappers* explícitos que
transformam a linha em objeto de domínio via `rehydrate`. A consequência assumida: não usamos Identity Map nem
`LockMode`; o lock é um `SELECT ... FOR UPDATE` explícito, mais legível e auditável do que um efeito colateral.

### 7.2 Money no banco

Valor em `numeric(20,2)` e moeda em `char(3)`, em colunas separadas. O driver devolve `numeric` como **string**,
que entra em `Money.from`; nunca passa por `number`. Os valores gravados vêm de `Money.toJSON().amount`.

### 7.3 Concorrência

A unidade de concorrência é a wallet, e a estratégia é **lock pessimista por linha**: `SELECT ... FOR UPDATE` na
linha da wallet, nunca um lock global. Justificativa: uma *hot wallet* tem alta chance de conflito, e o
*optimistic locking* com retry desperdiçaria trabalho (e reexecutaria efeitos) justamente no caso difícil; o lock
serializa só quem disputa o mesmo saldo e deixa wallets diferentes em paralelo.

Camadas de proteção, da mais externa à mais interna:

1. **Idempotência:** `INSERT ... ON CONFLICT DO NOTHING` na transação decide quem processa (seção 6.3).
2. **Lock da wallet** antes de ler o saldo. A ordem é sempre *linha da transação, depois wallet*, o que evita
   deadlock entre unidades de trabalho.
3. **Versão otimista no `UPDATE`:** `update wallets ... where id = ? and version = ?`; se nenhuma linha for
   afetada, lança `OptimisticLockError`. Não deveria ocorrer sob o lock; é a rede de segurança contra um bug.
4. **Constraints e triggers** (7.5): mesmo um escritor errado não consegue corromper o saldo.

### 7.4 Schema

| Tabela | Chaves e unicidade |
|---|---|
| `wallets` | PK `id`; **único** `(player_id, currency)`; `balance >= 0`; `version >= 1` |
| `wager_transactions` | PK `id`; **único** `idempotency_key`; **único** `(provider_id, external_transaction_id)`; índice único parcial `(reference_transaction_id, kind)` para reversões `PROCESSED`; índice parcial para o worker de `PENDING_REFERENCE` |
| `wallet_ledger_entries` | PK `id`; `seq` identity (ordem estável do cursor); **único** `(wallet_id, transaction_id)` |
| `inbox_messages` | PK `(consumer_name, message_id)` |
| `outbox_messages` | PK `id` (o `eventId`); índice parcial das não publicadas |

`wager_transactions.wallet_id` e `player_id` são `text` **sem chave estrangeira** de propósito: são dados do
provedor, e uma rejeição por wallet inexistente (`WALLET_NOT_FOUND`) precisa ser persistida e auditável.

### 7.5 Garantias aplicadas no banco

| Garantia | Mecanismo |
|---|---|
| Não-negatividade | `check (balance >= 0)`; saldos do ledger também |
| Unicidade | índices e constraints únicos (7.4) |
| Ledger imutável | trigger recusa `UPDATE`, `DELETE` e `TRUNCATE` em `wallet_ledger_entries` |
| Lançamento coerente | `check` aritmético: `balance_after = balance_before ± amount` conforme a direção |
| Encadeamento do ledger | trigger exige `balance_before` igual ao `balance_after` do lançamento anterior da wallet, e a mesma moeda |
| Saldo = ledger | *constraint trigger* adiada (`DEFERRABLE INITIALLY DEFERRED`) em `wallets` e em `wallet_ledger_entries`: no `COMMIT`, o saldo da wallet precisa igualar o `balance_after` do último lançamento (ou zero, sem lançamentos) |
| Transação terminal imutável | trigger recusa alterar `PROCESSED`/`REJECTED`/`FAILED`, alterar colunas de identidade e apagar |
| Estado coerente | `check`s ligando `status` a `processed_at`, `failure_code`, `next_reference_attempt_at` e `reference_transaction_id` |

A checagem *saldo = ledger* compara com o **último** lançamento, não com a soma de todos: o custo é constante, não
cresce com o histórico. Somada ao encadeamento, ela garante que o saldo é o replay do ledger inteiro.

### 7.6 Migrations

Escritas à mão em SQL, versionadas e **reversíveis** (`up` e `down`), em
`infrastructure/persistence/migrations/`. A migration 1 cria as tabelas, e a 2 cria os triggers. Execução:

```bash
bun run migration:up       # aplica as pendentes
bun run migration:down     # reverte a última
bun run migration:status
```

### 7.7 Testes de integração

`bun run test:integration` usa o PostgreSQL do `docker compose` (`bun run db:up`), em um banco **separado**,
`jungle_test` (criado se não existir; sobrescrevível por `TEST_DATABASE_URL`). Como cada teste recria o schema
(`down` e `up` completos, o que também prova a reversibilidade), o nome do banco precisa terminar em `_test`,
senão a suíte recusa rodar. Cobre:

- **migrations:** aplicam, revertem e reaplicam;
- **constraints:** cada garantia da seção 7.5 é testada tentando violá-la por SQL direto;
- **idempotência:** a mesma `BET` 50 vezes em paralelo gera um único débito; replay após reinício da conexão;
  conflito de payload; redelivery SQS 20 vezes em paralelo;
- **saldo:** duas apostas de 80 sobre 100; *hot wallet* com 100 apostas concorrentes sobre 50,00; 10 wallets
  em paralelo; criação concorrente de wallet para o mesmo jogador;
- **atomicidade:** queda antes do commit não deixa rastro em wallet, ledger, inbox, outbox nem transações;
- **referências fora de ordem:** `REFUND`/`ROLLBACK` antes da referência, esgotamento e 3 workers concorrentes;
- **outbox:** perda do processo depois do commit, 3 publishers concorrentes sobre a mesma outbox, queda do
  broker e publicação duplicada com o mesmo `eventId`.

A invariante `wallet.balance == saldo reconstruído pelo ledger` é verificada ao fim dos testes de dinheiro.

## 8. Bootstrap, configuração e operação

### 8.1 Composição

O `AppModule` só compõe módulos; as regras ficam nas camadas internas.

| Módulo | Entrega |
|---|---|
| `ConfigModule` (global) | `APP_CONFIG`, a configuração tipada e validada |
| `ObservabilityModule` | `JsonLogger` (port `Logger`), `PrometheusMetrics` (port `Metrics`), `LifecycleState` |
| `PersistenceModule` | `MikroOrmModule.forRootAsync` (sem *request context*, pois não usamos Identity Map), `UnitOfWork`, `DatabaseStartupCheck` |
| `ApplicationModule` | `Clock`, `IdGenerator`, `WagerTransactionProcessor` e os use cases, montados por *factories* |

A injeção é **sempre explícita** (`@Inject(TOKEN)` e `useFactory`), nunca por metadata de tipos do compilador
(`emitDecoratorMetadata`): o Vitest usa esbuild, que não emite essa metadata, e as *factories* mantêm os use
cases livres de decorators do NestJS. Os tokens são as próprias classes abstratas das portas.

### 8.2 Configuração

Lida do ambiente por `loadConfig`, validada de uma vez: um valor inválido **impede o start** e a mensagem lista
**todos** os problemas, não só o primeiro. O `.env` é carregado por `process.loadEnvFile` (Node) ou
automaticamente (Bun); variáveis já presentes no ambiente têm precedência. A senha do banco é mascarada no log
de start. Ver `.env.example`.

| Variável | Padrão | Observação |
|---|---|---|
| `DATABASE_URL` | obrigatória | `postgres://` ou `postgresql://` |
| `DATABASE_POOL_MIN` / `MAX` | `2` / `20` | `min` não pode superar `max` |
| `DATABASE_REQUIRE_MIGRATED` | `true` | recusa subir com migrations pendentes |
| `NODE_ENV` | `development` | `development`, `test` ou `production` |
| `LOG_LEVEL` | `info` (`error` em `test`) | `debug`, `info`, `warn`, `error` |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | |
| `HTTP_BODY_LIMIT` | `100kb` | corpos maiores recebem `413` |
| `HTTP_TRUST_PROXY` | `false` | `true`, `false` ou número de saltos |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `65000` | acima do idle de 60s de LBs comuns |
| `HTTP_HEADERS_TIMEOUT_MS` | `66000` | precisa ser maior que o keep-alive |
| `HTTP_REQUEST_TIMEOUT_MS` | `30000` | |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | tempo máximo do encerramento gracioso |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | tentativas do `PENDING_REFERENCE` (seção 6.4) |

### 8.3 Camada HTTP (`configureApp`)

Ordem dos middlewares: contexto da requisição, cabeçalhos de segurança, *access log*, *parser* JSON, tradução de
erros do *parser*. O app é criado com `bodyParser: false`: o JSON é registrado por nós, para que seus erros
virem códigos estáveis (o Nest converte `SyntaxError` em `BadRequest` genérico e perde o tipo do erro) e para
não aceitar `urlencoded`, que uma API JSON não precisa.

- `X-Powered-By` removido; `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Cross-Origin-Resource-Policy`, `Content-Security-Policy` restritiva e `Cache-Control: no-store` (respostas
  financeiras não devem ser cacheadas).
- Sem CORS: o serviço é chamado por outros serviços, não por navegadores.
- *Timeouts* do servidor aplicados a partir da configuração.
- **Correlation id:** `X-Correlation-Id` do chamador é aceito se casar `[A-Za-z0-9._:-]{1,128}`; senão é gerado
  um UUID. Vai no cabeçalho de resposta e em todo log da requisição.

### 8.4 Erros

Todo erro vira `application/problem+json` (formato do RFC 9457) pelo `AllExceptionsFilter`:

```json
{ "type": "about:blank", "title": "Bad Request", "status": 400, "code": "MALFORMED_JSON",
  "detail": "request body is not valid JSON", "correlationId": "..." }
```

- `code` é estável e legível por máquina. Um `HttpException` pode carregar o seu no corpo
  (`{ code, message }`); é o mecanismo para mapear os erros de negócio na API.
- Erros inesperados e 5xx respondem `INTERNAL_ERROR` **sem a mensagem original** (que pode vazar detalhes
  internos); a causa vai só para o log, com o mesmo `correlationId`.
- Os detalhes de erro do *parser* são fixos: nunca ecoam pedaços do corpo recebido.

### 8.5 Observabilidade

- **Logs:** uma linha JSON por evento (`time`, `level`, `service`, `correlationId`, `context`, `message`, campos).
  O `correlationId` vem de `AsyncLocalStorage`, então não precisa ser passado de mão em mão. Redação automática
  de chaves sensíveis (`password`, `secret`, `token`, `authorization`, `cookie`, `apiKey`, `credential`) e de
  `payload` e `body` inteiros; strings, listas e profundidade são limitadas; referências circulares e `bigint`
  não quebram o log.
- **Access log:** método, caminho **sem query string**, status e duração. Probes (`/health/*`, `/metrics`) saem
  em `debug`.
- **Métricas:** registro próprio em formato Prometheus (contadores e histogramas), sem dependência. Nunca lança
  (métrica não pode derrubar uma transação de dinheiro): nomes inválidos são ignorados e há teto de 1.000 séries
  por métrica contra explosão de cardinalidade. `render()` alimentará o `/metrics`.

### 8.6 Ciclo de vida

- **Start:** `DatabaseStartupCheck` testa a conexão e confere se todas as migrations foram aplicadas; se houver
  pendentes, o processo **não sobe** e a mensagem diz quais e qual comando rodar. Migrations não rodam
  automaticamente no start (várias instâncias subindo juntas disputariam a mudança de schema): são um passo de
  deploy (`bun run migration:up`).
- **Stop:** em `SIGTERM`/`SIGINT` o serviço marca `LifecycleState` (para a *readiness* passar a falhar e o
  balanceador tirar a instância), para de aceitar conexões, espera as requisições em andamento e fecha o pool
  do banco, com o limite de `SHUTDOWN_TIMEOUT_MS` (depois disso força `exit 1`). `unhandledRejection` e
  `uncaughtException` são logados e levam ao mesmo encerramento com `exit 1`, porque o estado do processo não é
  mais confiável.
- **Falha de start:** erro de configuração ou do check do banco sai como uma linha JSON `fatal` no `stderr`
  (com a lista de problemas) e `exit 1`.

### 8.7 Execução

```bash
bun run db:up              # PostgreSQL e LocalStack
bun run migration:up       # schema
bun run dev                # Bun com --watch
bun run start:bun          # Bun
bun run build && bun run start:prod   # Node, a partir de dist/
```

## 9. API HTTP

### 9.1 Endpoints

| Método e caminho | Papel | Sucesso |
|---|---|---|
| `POST /wallets` | cria a wallet (saldo inicial positivo gera `OPENING`) | `201` |
| `GET /wallets/:walletId` | consulta | `200` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | extrato paginado por cursor opaco (`limit` 1 a 200, padrão 50) | `200` |
| `POST /wallets/:walletId/reconciliation` | compara saldo e ledger, sem corrigir | `200` |
| `POST /wagering/transactions` | submete uma operação (header `Idempotency-Key`) | `200`, `202` ou `422` |
| `GET /wagering/transactions/:transactionId` | consulta pelo id interno | `200` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor | `200` |
| `GET /health/live`, `GET /health/ready` | probes | `200` ou `503` |
| `GET /metrics` | métricas Prometheus | `200` |

### 9.2 Mapeamento de status

O mapeamento é único para todos os endpoints (um só filtro de exceções mais o status do resultado de
`POST /wagering/transactions`), então o provedor decide reenviar, corrigir ou desistir sem interpretar mensagens:

| Situação | Status | `code` | O que o provedor faz |
|---|---|---|---|
| Operação aplicada (inclui replay) | `200` | | segue em frente |
| Aceita, aguardando a referência | `202` | corpo traz `status: PENDING_REFERENCE` | aguarda; consulta o status depois |
| Rejeição de negócio | `422` | corpo traz `status: REJECTED` e `failureCode` | **não reenvia**; age conforme o `failureCode` (seção 5.5) |
| Payload ou parâmetro inválido | `400` | `VALIDATION_ERROR` (com `errors[].path`), `INVALID_MONEY`, `INVALID_TRANSACTION`, `INVALID_QUERY`, `MALFORMED_JSON` | corrige e reenvia |
| Conflito de idempotência | `409` | `IDEMPOTENCY_PAYLOAD_MISMATCH`, `IDEMPOTENCY_EXTERNAL_ID_REUSED` | **não reenvia**; é um erro do chamador |
| Wallet já existente | `409` | `WALLET_ALREADY_EXISTS` | usa a existente |
| Recurso inexistente | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` | |
| Corpo grande demais | `413` | `PAYLOAD_TOO_LARGE` | |
| Falha transitória de infraestrutura | `503` + `Retry-After: 1` | `TEMPORARILY_UNAVAILABLE` | **reenvia com a mesma `Idempotency-Key`** (seguro) |
| Erro inesperado | `500` | `INTERNAL_ERROR` | reenvia com a mesma chave; a causa está no log com o `correlationId` |

Falha transitória cobre queda ou recusa de conexão, deadlock, falha de serialização e conflito de lock
(classificadas por SQLSTATE, por causa encadeada e por mensagens conhecidas do pool de conexões, como
`Connection terminated unexpectedly`, que o driver lança sem código quando o servidor para; ver
`transient-errors.ts`). Um erro de constraint ou de
programação **não** é tratado como transitório, para o provedor não reenviar em loop algo que nunca vai passar.
A rejeição `422` é definitiva e **também é devolvida igual no replay**.

### 9.3 Validação de entrada

Schemas Zod **estritos** (`z.strictObject`): propriedade desconhecida é erro, para que um erro de digitação nunca
desapareça em silêncio. `playerId` e `walletId` são UUID (normalizados para minúsculas); textos têm tamanho
máximo; `kind` aceita só `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` (`OPENING` é interno e vira `400`). O
formato do dinheiro (escala, sinal, notação científica) é decidido pelo `Money`, uma única fonte da verdade, e
volta como `INVALID_MONEY`. O `Idempotency-Key` aceita de 1 a 255 caracteres ASCII imprimíveis, sem espaços.

### 9.4 Autenticação

**Não implementada**, conforme a seção 2 do enunciado (não vale pontos e não compete com o núcleo financeiro).
O ponto de extensão está explícito: `AuthGuard` (classe abstrata) registrado como `APP_GUARD`, hoje com a
implementação `NoopAuthGuard`. O desenho adotado seria:

- um IdP externo (Keycloak ou Zitadel, via OIDC) emitindo tokens por provedor, sem tabela de usuários nem hash
  de senha no serviço;
- um `AuthGuard` que valida o JWT contra o JWKS do IdP e extrai a identidade do provedor;
- uma regra de domínio: o `providerId` do token precisa ser igual ao `providerId` do corpo, senão `403`;
- `/health/*` abertos (probes) e `/metrics` restrito à rede interna;
- o canal SQS continua tratado como interno e confiável, mas a identidade do provedor na mensagem passa pelas
  mesmas validações de domínio.

### 9.5 Métricas

| Métrica | Rótulos |
|---|---|
| `wager_transactions_total` | `kind`, `status` (somente resultados novos) |
| `wager_duplicates_total` | `kind` (replays detectados) |
| `wager_idempotency_conflicts_total` | `reason` |
| `wager_processing_seconds` (histograma) | `kind` |
| `wager_reference_retries_total` | `outcome` |
| `outbox_lag_seconds` (histograma), `outbox_publish_failures_total` | |
| `wallet_reconciliations_total` | `result` |
| `db_lock_conflicts_total`, `db_transient_errors_total` | `kind` |
| `http_requests_total`, `http_request_duration_seconds` | `method`, `route` (padrão da rota, não o caminho), `status` |

Os rótulos de rota usam o padrão (`/wallets/:walletId`), nunca o caminho cru, e rotas inexistentes viram
`unmatched`: a cardinalidade fica limitada mesmo sob varredura de URLs.

## 10. Mensageria (SQS) e workers

### 10.1 Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada: mensagens `WagerTransactionRequested` dos provedores |
| `wager-transactions-dlq.fifo` | mensagens que o consumer não consegue ou não deve processar |
| `wager-events.fifo` | saída: eventos de integração publicados pela outbox |

A mensagem de entrada segue o contrato do enunciado (`messageId`, `type`, `occurredAt`, `data`) e passa pelo
mesmo schema estrito da API HTTP, além de `idempotencyKey` e `messageId`. O `MessageGroupId` esperado é o
`walletId`: a ordenação do FIFO por wallet é uma **otimização**, não a garantia (que vem do banco).

### 10.2 Consumer

Long polling em lote. Mensagens do mesmo grupo são processadas em sequência e grupos diferentes em paralelo. O
consumer chama o **mesmo `SubmitWagerTransaction`** do HTTP, com `source = (wager-transactions, messageId)`,
então a inbox, a transação financeira, o ledger e a outbox confirmam juntos. O `ack` (`DeleteMessage`) só
acontece **depois** do commit.

| Resultado | Ação |
|---|---|
| Processada: inclui replay, rejeição de negócio (`422` no HTTP) e `PENDING_REFERENCE` | `ack` |
| Corpo que não é JSON ou viola o schema | DLQ, motivo `MALFORMED` |
| Dinheiro ou transação inválidos | DLQ, motivo `INVALID` |
| Chave de idempotência reutilizada com conteúdo diferente | DLQ, motivo `CONFLICT` |
| Falha transitória ou erro desconhecido | **retry** com backoff (`ChangeMessageVisibility`): 5s, 10s, 20s... até 300s |
| Falha que persiste até `SQS_MAX_ATTEMPTS` (padrão 5) | DLQ, motivo `RETRIES_EXHAUSTED` |

Uma rejeição de negócio (ex.: saldo insuficiente) é uma **resposta final**, não uma falha: vai para o `ack`, e o
resultado fica na transação. Só o que nunca vai dar certo (malformado, inválido, conflito) vai para a DLQ de
imediato. A mensagem na DLQ preserva o corpo original e os atributos `deadLetterReason`, `originalMessageId` e
`receiveCount`. Erros desconhecidos são tratados como transitórios, com limite de tentativas, para nada se perder
em silêncio.

Janelas de falha cobertas: se o processo morre **depois do commit e antes do `ack`**, a mensagem volta após o
visibility timeout, cai no caminho de replay e é confirmada sem novo efeito; se morre **antes do commit**, nada foi
gravado e a reentrega processa normalmente.

### 10.3 Encerramento

O `stop()` do consumer **não aborta** o long-poll em andamento: abortar a requisição no cliente não a cancela no
servidor, e a próxima mensagem que chegasse seria entregue a uma conexão morta e ficaria invisível até o
visibility timeout (o teste de integração reproduziu exatamente isso). Em vez disso, o consumer termina a
mensagem em processamento, **libera** (`VisibilityTimeout = 0`) as que o poll devolver e as que ainda não
começaram, e para. O custo é esperar até `SQS_WAIT_TIME_SECONDS`.

### 10.4 Publicação de eventos

`PublishOutbox` envia cada mensagem da outbox ao `wager-events.fifo`, com `MessageDeduplicationId = eventId`,
`MessageGroupId = walletId` e os atributos `eventType`, `eventId` e `correlationId`. A entrega é *at-least-once*:
se o processo morre depois do SQS aceitar e antes do commit, outro publisher reenvia. A deduplicação do FIFO
(janela de 5 minutos) remove esse duplicado na fila, mas **não é a garantia**: o consumidor deve deduplicar pelo
`eventId`.

### 10.5 Workers

Dois laços periódicos (`PeriodicTask`), em todas as instâncias: o publisher da outbox e o reprocessamento de
`PENDING_REFERENCE`. Cada um nunca se sobrepõe a si mesmo, repete imediatamente quando o lote veio cheio, espera o
intervalo quando não há mais trabalho, e uma falha de tick é registrada e contada sem derrubar o laço. Como ambos
usam `FOR UPDATE SKIP LOCKED`, várias instâncias dividem o trabalho sem coordenação. `WORKERS_ENABLED=false` e
`SQS_CONSUMER_ENABLED=false` permitem separar papéis (por exemplo, instâncias só de HTTP).

### 10.6 Variáveis e métricas

| Variável | Padrão |
|---|---|
| `SQS_QUEUE_URL`, `SQS_DLQ_URL`, `SQS_EVENTS_QUEUE_URL` | obrigatórias |
| `AWS_REGION` / `AWS_ENDPOINT_URL` | `us-east-1` / opcional (LocalStack) |
| `SQS_CONSUMER_ENABLED` | `true` |
| `SQS_MAX_MESSAGES` / `SQS_WAIT_TIME_SECONDS` | `10` / `20` |
| `SQS_MAX_ATTEMPTS` | `5` (precisa ser ≤ `maxReceiveCount` da fila) |
| `SQS_RETRY_BASE_SECONDS` / `SQS_RETRY_MAX_SECONDS` | `5` / `300` |
| `WORKERS_ENABLED` | `true` |
| `OUTBOX_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `1000` / `50` |
| `PENDING_REFERENCE_INTERVAL_MS` / `PENDING_REFERENCE_BATCH_SIZE` | `5000` / `50` |

Métricas: `sqs_messages_total{outcome}` (`processed`, `retry`, `dead_letter`, `released`),
`sqs_dlq_messages_total{reason}`, `sqs_retries_total`, `sqs_malformed_messages_total{cause}`,
`sqs_receive_errors_total`, `sqs_message_processing_seconds`, `worker_ticks_total{task}` e
`worker_failures_total{task}`. O `/health/ready` inclui o `sqs` (acessibilidade das filas de entrada e de eventos).

### 10.7 Testes

- **Unitários:** política de desfecho, `WagerMessageHandler` (cada ramo da tabela 10.2) e `PeriodicTask`.
- **Integração com LocalStack e PostgreSQL reais** (`test:integration`): consumo e `ack` após o commit; mesma
  mensagem enviada 3 vezes com efeito único; **worker morto depois do commit e antes do `ack`**; rejeição de
  negócio com `ack`; cada motivo de DLQ; **retry com o banco fora e recuperação**; esgotamento de tentativas;
  encerramento que libera mensagens e um segundo consumer concluindo o trabalho exatamente uma vez; 3 consumers
  dividindo 60 mensagens; *hot wallet* com 80 mensagens sobre 50,00; publicação da outbox e publisher morto após
  o envio; health do SQS.
- **e2e com o app completo** (consumer e workers ligados): mensagem vira saldo e eventos; referência fora de
  ordem resolvida pelo worker; mensagem envenenada sem travar o serviço; readiness e métricas; shutdown rápido.
- **e2e com 3 processos reais** (`bun src/main.ts`, mesmo PostgreSQL e mesma fila): *hot wallet* alimentada por
  HTTP nas 3 instâncias e por SQS ao mesmo tempo (250 apostas de 1,00 sobre 100,00: exatamente 100 aceitas e 150
  rejeitadas, saldo 0,00); a mesma `BET` 70 vezes por HTTP e SQS com 1 débito; **um processo morto com `SIGKILL`
  no meio do processamento**, 300 mensagens aplicadas exatamente uma vez pelos sobreviventes e reinício
  saudável; todos os eventos entregues uma única vez na fila.

## 11. Interpretações adicionais do enunciado

O enunciado pede que interpretações adicionais sejam documentadas:

- Toda transação exige **valor positivo**, inclusive `WIN` e `LOSS`.
- `BET` não aceita referência. `WIN` e `LOSS` aceitam uma referência opcional a `BET`.
- `ROLLBACK` não pode referenciar `LOSS`, `OPENING` nem outro `ROLLBACK`.
- A referência precisa estar `PROCESSED` para ser revertida ou usada.
- Wallet aberta com saldo zero não gera `OPENING` nem lançamento.
- A mesma operação do provedor (`providerId` + `externalTransactionId`) enviada com **outra** idempotency key é
  conflito (`EXTERNAL_ID_REUSED`), não replay: o header é a fonte da verdade.
- O replay de uma transação devolve seu **estado atual** (ex.: uma `PENDING_REFERENCE` já resolvida volta como
  `PROCESSED`), sempre com o saldo observado quando o resultado foi decidido.
- Os eventos de integração saem por uma terceira fila FIFO, `wager-events.fifo`: o enunciado lista apenas a fila
  de entrada e a DLQ, e não diz para onde a outbox publica.
- O `LOG_LEVEL` padrão em `test` é `error`, para a saída dos testes ficar limpa.

## 12. Infraestrutura local

```bash
docker compose up -d
```

| Serviço | Imagem | Porta |
|---|---|---|
| `postgres` | `postgres:17-alpine` | 5432 |
| `localstack` | `localstack/localstack:3.8.1` | 4566 |

- A versão do LocalStack está **fixa**: as tags mais recentes exigem `LOCALSTACK_AUTH_TOKEN`.
- Filas criadas por `docker/localstack/init-sqs.sh` (seção 10.1). `maxReceiveCount=5` na redrive policy da fila
  principal; o `SQS_MAX_ATTEMPTS` da aplicação não pode passar disso.
- As filas de requisições usam `ContentBasedDeduplication=true` por conveniência em dev. **A garantia de
  idempotência vem da inbox e da chave no banco**, não do SQS FIFO (restrição inviolável nº 3 do enunciado).
- Variáveis de ambiente: ver `.env.example`.

## 13. Como trabalhamos

- **Commits** em inglês, no padrão Conventional Commits (`feat`, `fix`, `test`, `docs`, `build`, `chore`,
  `style`), pequenos e focados, um arquivo por commit.
- **Qualidade antes de commitar**: `prettier`, `oxlint`, `tsc --noEmit`, `vitest` e `test:integration` limpos.
- **Testes** unitários acompanham cada classe de domínio e cada use case. Integração, e2e e concorrência rodam
  contra PostgreSQL e SQS (LocalStack) reais em containers, como pede o enunciado, nunca contra mocks.
- **Invariantes no banco**: unicidade, imutabilidade do ledger e não-negatividade do saldo são aplicadas por
  constraints e triggers nas migrations, não só em código.

## 14. Pendências

| Tema | Situação |
|---|---|
| Teste de carga (diferencial opcional) | não implementado; se feito, exposto como `bun run test:load` |
| Autenticação com IdP | não implementada (seção 9.4); o ponto de extensão existe |
| Guia de setup no `README.md` | pendente (o `README.md` atual é o enunciado do desafio) |

## 15. Limitações conhecidas

- `/metrics` e `/health/*` não exigem autenticação e devem ficar em rede interna (ou atrás de regra no
  gateway). O `/metrics` expõe nomes de rota e contagens, nunca dados de jogador.

- O encerramento gracioso é testado com um processo simulado (sinais emitidos em um `EventEmitter`). A entrega
  real de `SIGTERM` não pôde ser verificada no Windows de desenvolvimento e fica para a execução em container
  Linux, junto do teste com múltiplas instâncias.
- Não há *rate limiting*, TLS nem CORS: o serviço é interno e assume um proxy ou gateway à frente. O
  `X-Correlation-Id` do chamador é aceito (se bem formado) por rastreabilidade, não por confiança.

- Os testes unitários dos use cases usam fakes em memória que **serializam** as unidades de trabalho e não têm
  rollback: provam a lógica, não a concorrência nem a atomicidade. Isso é provado pelos testes de integração
  contra PostgreSQL real (seção 7.7).
- Os testes de concorrência cobrem dois níveis: muitas requisições paralelas dentro de um processo (cada
  unidade de trabalho em sua própria conexão e transação) e **3 processos reais** do serviço (seção 10.7). Não
  há teste de carga (`test:load`), que o enunciado trata como diferencial opcional.
- O `SQS_MAX_ATTEMPTS` precisa ser **menor ou igual** ao `maxReceiveCount` da redrive policy da fila (5). Se for
  maior, o SQS move a mensagem para a DLQ por conta própria, sem o atributo `deadLetterReason`. O serviço não
  confere isso na subida.
- Não há ferramenta de reprocessamento da DLQ: as mensagens ficam preservadas com o corpo original e o motivo,
  para inspeção e reenvio manual.
- O encerramento do consumer espera até `SQS_WAIT_TIME_SECONDS` (o long-poll em andamento) e libera o que ele
  devolver (seção 10.3); `SHUTDOWN_TIMEOUT_MS` precisa ser maior que esse tempo.
- Não há retry automático de erros transitórios do banco (deadlock `40P01`, falha de serialização `40001`,
  conexão perdida): hoje o erro sobe ao chamador. O desenho evita deadlocks (a ordem é sempre: linha da
  transação, depois wallet), mas a política de retry pertence aos adapters de entrada.
- O publisher da outbox mantém o lock das linhas durante a chamada ao broker. Com lotes pequenos é aceitável;
  se a latência do broker virar problema, separar "reservar" de "publicar".
- O worker de `PENDING_REFERENCE` trata um erro inesperado propagando-o: uma transação "envenenada" que sempre
  falha bloquearia a fila até ser corrigida. Um circuito de isolamento (marcar `FAILED` após N falhas
  inesperadas) fica como evolução.
- Um `REFUND` seguido de `ROLLBACK` da mesma `BET` é aceito (a regra 4 do enunciado proíbe repetir o **mesmo
  tipo** de reversão).
