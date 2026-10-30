# STEPS: setup e roteiro de testes

Guia para subir o serviço do zero e comprovar, passo a passo, cada garantia do desafio. Todos os comandos e as
saídas esperadas abaixo foram executados contra o projeto.

Tempo estimado: 10 minutos para o setup e o roteiro manual; cerca de 2 minutos para todos os testes automatizados.

## 0. Resumo

```bash
git clone <repositório> jungle-challenger && cd jungle-challenger
bun install
cp .env.example .env
bun run db:up              # PostgreSQL + LocalStack (SQS), espera ficarem saudáveis
bun run migration:up       # cria o schema
bun run start:bun          # sobe o serviço em http://localhost:8080
```

Em outro terminal: `curl http://localhost:8080/health/ready`. Para rodar os testes: `bun run test`,
`bun run test:integration` e `bun run test:e2e` (seção 4).

Testes de carga (k6): veja [LOAD.md](./LOAD.md).

## 1. Pré-requisitos

| Ferramenta | Versão testada | Observação |
|---|---|---|
| [Bun](https://bun.sh) | 1.4.4 | runtime do serviço e gerenciador de pacotes (o enunciado exige Bun 1.x) |
| Docker com Compose v2 | Docker 29, Compose 5.3 | no Windows e no macOS, o Docker Desktop precisa estar **aberto** |
| Node.js | 24 | usado pelo Vitest e pelo `nest build`; o serviço em si roda no Bun |
| Git | qualquer | |

Portas livres: `5432` (PostgreSQL), `4566` (LocalStack) e `8080` (serviço; `8081` se for subir uma segunda
instância).

No Windows, rode os exemplos de `curl` no **Git Bash** (ou WSL). No PowerShell, `curl` é um alias de outro
comando: use `curl.exe`, e a sintaxe dos exemplos precisa ser adaptada.

## 2. Setup

### 2.1 Instalar dependências

```bash
bun install
```

Em um ambiente limpo, `bun install --frozen-lockfile` também funciona (o lockfile está commitado).

### 2.2 Variáveis de ambiente

```bash
cp .env.example .env
```

O `.env.example` já aponta para o PostgreSQL e o LocalStack do `docker-compose.yml`. A única variável sem padrão é
`DATABASE_URL`, e as três URLs de fila (`SQS_QUEUE_URL`, `SQS_DLQ_URL`, `SQS_EVENTS_QUEUE_URL`); se faltar alguma, o
serviço **não sobe** e lista todos os problemas de uma vez. A lista completa de variáveis e padrões está na seção
8.2 do [ARCHITECTURE.md](./ARCHITECTURE.md).

### 2.3 Subir a infraestrutura

```bash
bun run db:up
```

Isso executa `docker compose up -d --wait` e só retorna quando os dois containers estão saudáveis (a primeira vez
baixa as imagens e pode levar alguns minutos). Confira:

```bash
docker compose ps
docker exec jungle-localstack awslocal sqs list-queues
```

Devem existir três filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. Elas são
criadas pelo `docker/localstack/init-sqs.sh` quando o LocalStack fica pronto.

> No Git Bash, se um `docker exec` receber um caminho que começa com `/`, o Git converte o caminho para o do
> Windows. Prefixe o comando com `MSYS_NO_PATHCONV=1` nesses casos.

### 2.4 Criar o schema

```bash
bun run migration:up        # applied 2 migration(s)
bun run migration:status    # executed: ..., pending: -
```

O serviço **recusa subir** se houver migration pendente (e diz qual comando rodar). Para desfazer a última:
`bun run migration:down`.

### 2.5 Subir o serviço

```bash
bun run start:bun    # ou: bun run dev  (reinicia ao salvar arquivos)
```

As linhas de log são JSON, uma por evento. Para ver só avisos e erros: `LOG_LEVEL=warn bun run start:bun`.

Alternativa em Node, a partir do build: `bun run build && bun run start:prod`.

### 2.6 Verificar

```bash
curl -s localhost:8080/health/live    # {"status":"up"}
curl -s localhost:8080/health/ready
# {"status":"up","checks":{"postgres":{"status":"up","latencyMs":4},"sqs":{"status":"up","latencyMs":7}}}
```

## 3. Roteiro manual

Cada passo mostra o comando e o que você deve ver. Os valores monetários são sempre strings com 2 casas.

### 3.0 Preparar o shell

Cole este bloco uma vez no terminal onde vai rodar o roteiro (Git Bash, WSL, Linux ou macOS):

```bash
export API=http://localhost:8080
R=$(date +%s)   # sufixo para os ids não colidirem entre execuções

uuid() { node -p "crypto.randomUUID()"; }
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[process.argv[1]]))" "$1"; }
balance() { curl -s $API/wallets/$WALLET | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).balance.amount"; }

# op <id externo> <BET|WIN|LOSS|REFUND|ROLLBACK> <valor> [id externo da referência]
op() {
  local ref=""; [ -n "$4" ] && ref=",\"referenceExternalTransactionId\":\"$4\""
  curl -s -w ' [HTTP %{http_code}]\n' -X POST $API/wagering/transactions \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$1" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$ref}"
}

# cria uma wallet nova com o saldo informado e deixa PLAYER e WALLET definidos
new_wallet() {
  PLAYER=$(uuid)
  WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
    -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"$1\",\"currency\":\"BRL\"}}" | jget id)
  echo "WALLET=$WALLET  saldo=$(balance)"
}
```

### Passo 1: criar uma wallet

```bash
PLAYER=$(uuid)
curl -s -w ' [HTTP %{http_code}]\n' -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
```

Esperado: `HTTP 201` e `{"id":"...","playerId":"...","balance":{"amount":"100.00","currency":"BRL"},"version":1}`.

O saldo inicial gerou uma transação interna `OPENING` e um lançamento `CREDIT` no ledger, na mesma transação SQL.
Tente criar de novo para o mesmo jogador e moeda: `HTTP 409` com `"code":"WALLET_ALREADY_EXISTS"`.

### Passo 2: o cenário obrigatório do enunciado (2 apostas de 80 sobre 100)

```bash
new_wallet 100.00
op a-$R BET 80.00 & op b-$R BET 80.00 & wait
echo "saldo final: $(balance)"
```

Esperado, em qualquer ordem de chegada:

```
{"transactionId":"...","status":"PROCESSED","balance":{"amount":"20.00",...},"idempotentReplay":false} [HTTP 200]
{"transactionId":"...","status":"REJECTED","balance":{"amount":"20.00",...},"failureCode":"INSUFFICIENT_FUNDS","idempotentReplay":false} [HTTP 422]
saldo final: 20.00
```

Exatamente uma aposta processada, a outra rejeitada por saldo insuficiente, saldo `20.00` e um único débito.

### Passo 3: idempotência

```bash
new_wallet 1000.00
op bet-$R BET 25.00     # 200, PROCESSED, saldo 975.00, idempotentReplay:false
op bet-$R BET 25.00     # 200, mesmo transactionId, idempotentReplay:true
op bet-$R BET 30.00     # 409, IDEMPOTENCY_PAYLOAD_MISMATCH (mesma chave, conteúdo diferente)
curl -s -w ' [HTTP %{http_code}]\n' -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -d '{}'   # 400, VALIDATION_ERROR (sem Idempotency-Key e sem campos)
```

O replay devolve o **resultado original**, inclusive o saldo observado naquele momento, mesmo que a wallet já tenha
mudado depois. Mesma chave com conteúdo diferente é conflito (`409`), nunca replay.

A mesma aposta 50 vezes em paralelo:

```bash
for i in $(seq 1 50); do op par-$R BET 10.00 & done > /tmp/par.out; wait
echo "primeiro processamento: $(grep -o '"idempotentReplay":false' /tmp/par.out | wc -l)"
echo "replays: $(grep -o '"idempotentReplay":true' /tmp/par.out | wc -l)"
echo "saldo: $(balance)"   # esperado 965.00
```

Esperado: `primeiro processamento: 1`, `replays: 49` e saldo `965.00` (975,00 menos um único débito de 10,00).

### Passo 4: reversões (`REFUND` e `ROLLBACK`)

```bash
op refund1-$R REFUND 25.00 bet-$R    # 200, saldo volta a 990.00
op refund2-$R REFUND 25.00 bet-$R    # 422, REJECTED, ALREADY_REVERSED: a BET só é revertida uma vez
echo "saldo: $(balance)"
```

Uma reversão que deixaria o saldo negativo é rejeitada com um `failureCode` próprio
(`REVERSAL_WOULD_OVERDRAW`), diferente do `INSUFFICIENT_FUNDS` de uma aposta. A taxonomia completa de códigos está
na seção 5.5 do [ARCHITECTURE.md](./ARCHITECTURE.md).

### Passo 5: referência fora de ordem

```bash
op late-refund-$R REFUND 5.00 late-bet-$R   # 202, PENDING_REFERENCE: a BET ainda não existe
echo "saldo: $(balance)"                    # inalterado
op late-bet-$R BET 5.00                     # 200: a BET chega depois
echo "saldo após a BET: $(balance)"
sleep 9                                     # o worker reprocessa com backoff exponencial
curl -s "$API/providers/provider-a/wagering/transactions/late-refund-$R" | jget status   # PROCESSED
echo "saldo após o worker: $(balance)"      # o REFUND foi aplicado
```

### Passo 6: extrato (ledger) e reconciliação

```bash
curl -s "$API/wallets/$WALLET/ledger?limit=3"; echo
curl -s -X POST $API/wallets/$WALLET/reconciliation; echo
```

O extrato é paginado por cursor opaco (`nextCursor` na resposta; passe como `&cursor=...`). A reconciliação compara o
saldo armazenado com o saldo reconstruído pelo ledger: esperado `"consistent":true` e `"difference":{"amount":"0.00",...}`.
Divergência nunca é corrigida em silêncio: é logada, contada em métrica e sinalizada na resposta.

### Passo 7: processar pela fila SQS

Defina os helpers de fila (usam o `awslocal` dentro do container do LocalStack):

```bash
QUEUE=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo
DLQ=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo
EVENTS=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-events.fifo
awsq() { docker exec jungle-localstack awslocal sqs "$@"; }
sqs_send() { awsq send-message --queue-url "$1" --message-group-id "$2" --message-deduplication-id "$(uuid)" --message-body "$3" > /dev/null; }
msg_bet() {
  printf '{"messageId":"msg-%s","type":"WagerTransactionRequested","occurredAt":"%s","data":{"providerId":"provider-a","externalTransactionId":"%s","idempotencyKey":"provider-a:%s","playerId":"%s","walletId":"%s","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"%s","currency":"BRL"}}}' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1" "$1" "$PLAYER" "$WALLET" "$2"
}
```

Envie uma aposta de 40,00:

```bash
new_wallet 500.00
sqs_send $QUEUE $WALLET "$(msg_bet q1-$R 40.00)"
sleep 3; echo "saldo: $(balance)"       # 460.00
```

Reenvie a **mesma** mensagem de negócio duas vezes (o FIFO aceita, pois o id de deduplicação do SQS é novo):

```bash
MSG=$(msg_bet q1-$R 40.00)
sqs_send $QUEUE $WALLET "$MSG"; sqs_send $QUEUE $WALLET "$MSG"
sleep 3; echo "saldo: $(balance)"       # continua 460.00
```

A deduplicação que vale não é a do SQS: é a inbox `(consumer, messageId)` e a chave de idempotência, ambas no
PostgreSQL.

### Passo 8: mensagem inválida vai para a DLQ

```bash
awsq purge-queue --queue-url $DLQ
sqs_send $QUEUE $WALLET 'this is not json'
sleep 3
awsq receive-message --queue-url $DLQ --message-attribute-names All --wait-time-seconds 3 --visibility-timeout 1 \
  --query 'Messages[0].{body:Body,reason:MessageAttributes.deadLetterReason.StringValue}'
echo "saldo: $(balance)"                # inalterado
```

Esperado: o corpo original e `"reason": "MALFORMED"`. Os motivos possíveis são `MALFORMED`, `INVALID`, `CONFLICT` e
`RETRIES_EXHAUSTED` (seção 10.2 do [ARCHITECTURE.md](./ARCHITECTURE.md)). Uma rejeição de negócio (saldo
insuficiente) **não** vai para a DLQ: é uma resposta final e a mensagem é confirmada.

### Passo 9: eventos publicados pela outbox

```bash
awsq receive-message --queue-url $EVENTS --message-attribute-names All --max-number-of-messages 3 \
  --wait-time-seconds 3 --visibility-timeout 1 --query 'Messages[].MessageAttributes.eventType.StringValue'
```

Esperado: tipos como `WalletBalanceChanged`, `WagerTransactionProcessed` e `WagerTransactionRejected`. Eles são
gravados na mesma transação SQL do dinheiro e publicados depois por um worker.

### Passo 10: métricas

```bash
curl -s $API/metrics | grep -E '^(wager|sqs|worker|outbox|db|http)_' | grep -v '_bucket'
```

Procure `wager_transactions_total{kind,status}`, `wager_duplicates_total`, `sqs_messages_total{outcome}`,
`sqs_dlq_messages_total{reason}`, `outbox_lag_seconds_*` e `worker_ticks_total{task}`.

### Passo 11: duas instâncias dividindo o trabalho

Em outro terminal:

```bash
PORT=8081 LOG_LEVEL=warn bun run start:bun
```

De volta ao primeiro terminal:

```bash
new_wallet 1000.00
for i in $(seq 1 40); do sqs_send $QUEUE $WALLET "$(msg_bet two-$R-$i 1.00)"; done
sleep 8
for p in 8080 8081; do echo "instância :$p -> $(curl -s localhost:$p/metrics | grep '^sqs_messages_total{outcome="processed"}')"; done
echo "saldo: $(curl -s localhost:8081/wallets/$WALLET | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).balance.amount")"
```

Esperado: as duas instâncias processaram parte das mensagens (a soma é 40) e o saldo é `960.00`. Os workers também
rodam em ambas, sem coordenação (`FOR UPDATE SKIP LOCKED`).

### Passo 12: o banco cai e volta

Com o serviço rodando:

```bash
docker stop jungle-postgres
curl -s -i -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$(uuid)\",\"initialBalance\":{\"amount\":\"1.00\",\"currency\":\"BRL\"}}" | grep -E '^HTTP|^Retry-After|"code"'
curl -s -w '\nready=%{http_code}\n' $API/health/ready
curl -s -o /dev/null -w 'live=%{http_code}\n' $API/health/live
docker start jungle-postgres
```

Esperado com o banco parado: `HTTP/1.1 503`, `Retry-After: 1`, `"code":"TEMPORARILY_UNAVAILABLE"`, `ready=503` com
`postgres: down`, e `live=200` (o processo está vivo). O `503` significa que **é seguro reenviar com a mesma
`Idempotency-Key`**. Poucos segundos depois de o banco voltar, `/health/ready` volta a `200` e as requisições passam,
sem reiniciar o serviço. Mensagens da fila ficam em retry com backoff durante a queda e são aplicadas depois.

## 4. Testes automatizados

Todos exigem a infraestrutura de pé (`bun run db:up`) e o schema aplicado, **exceto** os unitários.

| Comando | Quantidade | Tempo | O que usa |
|---|---|---|---|
| `bun run test` | 341 | ~2 s | nada externo |
| `bun run test:integration` | 57 | ~45 s | PostgreSQL e LocalStack reais |
| `bun run test:e2e` | 49 | ~40 s | PostgreSQL e LocalStack reais; o último arquivo sobe 3 processos do serviço |

- Os testes de integração e e2e usam um banco separado, o **`jungle_test`**, criado automaticamente. Eles recriam o
  schema a cada teste, então a suíte **se recusa a rodar** em qualquer banco cujo nome não termine em `_test`. O
  banco de desenvolvimento (`jungle`) nunca é tocado. Para usar outro, defina `TEST_DATABASE_URL`.
- Os arquivos rodam em série (compartilham banco e filas). As filas são esvaziadas no início e no fim das suítes
  que as usam.
- O teste de 3 processos usa o Bun em `~/.bun/bin/bun`; se o seu estiver em outro lugar, defina `BUN_BIN`.
- Para rodar um arquivo ou um teste: `bun run test:integration test/integration/sqs`, ou
  `bun run test:e2e -t "nome do teste"`.

### 4.1 Mapa: requisito do enunciado para o teste que o prova

**Unitários (seção 13 do enunciado)**

| Requisito | Onde |
|---|---|
| `Money`: escala, arredondamento, entradas inválidas | `test/domain/money/Money.spec.ts` |
| Invariantes da `Wallet` | `test/domain/wallet/Wallet.spec.ts` |
| Regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` | `test/domain/wagering/WagerTransaction.spec.ts`, `test/application/SubmitWagerTransaction.spec.ts` |
| Conflito de moeda | `Money.spec.ts`, `Wallet.spec.ts` |
| Idempotency key com payload divergente | `test/application/SubmitWagerTransaction.spec.ts`, `payload-hash.spec.ts` |

**Integração com PostgreSQL e LocalStack reais**

| Requisito | Onde |
|---|---|
| Migrations e constraints | `test/integration/migrations.int-spec.ts`, `constraints.int-spec.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `concurrency.int-spec.ts` ("atomicity") |
| Inbox e redelivery | `sqs.int-spec.ts` |
| Publishers concorrentes sobre a mesma outbox | `concurrency.int-spec.ts` ("transactional outbox") |
| Retry e DLQ | `sqs.int-spec.ts` ("permanent failures", "transient failures") |
| Recuperação após reinicialização | `concurrency.int-spec.ts` (replay após restart), `multi-process.e2e-spec.ts` |

**Concorrência (paralelismo real)**

| # | Requisito | Onde |
|---|---|---|
| 1 | Mesma aposta 50 vezes em paralelo, um único débito | `concurrency.int-spec.ts`; `api.e2e-spec.ts` (HTTP); `multi-process.e2e-spec.ts` (70 vezes, 3 processos, HTTP e SQS) |
| 2 | Duas apostas disputando o saldo (100 e 2 de 80) | `concurrency.int-spec.ts`, `api.e2e-spec.ts`, passo 2 deste roteiro |
| 3 | Wallets distintas em paralelo | `concurrency.int-spec.ts` |
| 4 | Três ou mais processos simultâneos | `multi-process.e2e-spec.ts` |
| 5 | Worker morto depois do commit e antes do ack | `sqs.int-spec.ts` |
| 6 | Dois publishers sobre a mesma outbox | `concurrency.int-spec.ts`, `multi-process.e2e-spec.ts` |
| 7 | `ROLLBACK`/`REFUND` antes da referência | `concurrency.int-spec.ts`, `messaging.e2e-spec.ts` |
| 8 | Reinício do serviço com consistência final | `multi-process.e2e-spec.ts` (um processo morto com `SIGKILL` e reiniciado) |

A invariante final `wallet.balance == saldo reconstruído pelo ledger` é verificada ao fim dos testes de dinheiro,
pela reconciliação, e é imposta pelo próprio banco (trigger adiado no `COMMIT`; ver a seção 7.5 do
[ARCHITECTURE.md](./ARCHITECTURE.md)).

## 5. Qualidade de código

```bash
bun run lint                      # oxlint (sem saída = sem problemas)
node_modules/.bin/tsc --noEmit    # checagem de tipos, TypeScript estrito
bun run format                    # prettier --write
bun run build                     # nest build, gera dist/
```

## 6. Operação e diagnóstico

| Quero | Comando |
|---|---|
| Ver o estado das dependências | `curl -s localhost:8080/health/ready` |
| Ver métricas | `curl -s localhost:8080/metrics` |
| Acompanhar uma requisição | todo log e toda resposta de erro trazem o `correlationId`; envie `X-Correlation-Id: meu-id` para escolher o seu |
| Inspecionar o banco | `docker exec -it jungle-postgres psql -U jungle -d jungle` (tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`) |
| Ver o ledger de uma wallet | `select * from wallet_ledger_entries where wallet_id = '...' order by seq;` |
| Contar mensagens nas filas | `docker exec jungle-localstack awslocal sqs get-queue-attributes --queue-url $QUEUE --attribute-names All` |
| Ver a DLQ | passo 8 |
| Reaplicar o schema do zero | `bun run migration:down` (repita até `pending` listar tudo) e `bun run migration:up` |

Tentar adulterar o ledger é recusado pelo banco:

```bash
docker exec jungle-postgres psql -U jungle -d jungle -c "update wallet_ledger_entries set amount = 1.00"
# ERROR: UPDATE on wallet_ledger_entries is not allowed: the table is append-only
```

## 7. Problemas comuns

| Sintoma | Causa e solução |
|---|---|
| `failed to connect to the docker API` | o Docker Desktop não está aberto; abra e espere ficar pronto |
| O serviço sai com `invalid configuration` e uma lista | falta ou está inválida alguma variável; confira o `.env` com o `.env.example` (principalmente `DATABASE_URL` e as três `SQS_*_URL`) |
| `database schema is not up to date; pending migrations` | rode `bun run migration:up` |
| `ECONNREFUSED 127.0.0.1:5432` ou `4566` | a infraestrutura não está de pé: `bun run db:up` |
| `db:up` demora na primeira vez | baixa as imagens; o LocalStack só fica saudável depois de criar as filas |
| `Address already in use` ao subir | outra instância usa a porta; mude com `PORT=8082` ou encerre a anterior |
| Nome de fila não resolve (`localhost.localstack.cloud`) | o DNS bloqueia o domínio; troque as URLs de fila no `.env` por `http://localhost:4566/000000000000/<nome-da-fila>` |
| `refusing to run destructive integration tests on database ...` | o `TEST_DATABASE_URL` aponta para um banco que não termina em `_test`; é a proteção funcionando |
| Teste de 3 processos falha ao iniciar o Bun | defina `BUN_BIN` com o caminho do executável |
| Sobrou mensagem na fila de uma execução anterior | `docker exec jungle-localstack awslocal sqs purge-queue --queue-url $QUEUE` |

## 8. Limpeza

```bash
docker compose down        # para os containers e mantém os dados
docker compose down -v     # para e apaga os volumes (banco e filas voltam do zero)
```

Depois de `down -v`, repita `bun run db:up` e `bun run migration:up`.

## 9. Mais detalhes

O desenho, os trade-offs e as limitações conhecidas estão no [ARCHITECTURE.md](./ARCHITECTURE.md): domínio (seção
5), idempotência (6.3), persistência e garantias no banco (7), API e mapeamento de status (9), mensageria (10) e
limitações (15).
