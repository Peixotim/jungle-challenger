# LOAD: testes de carga com k6

Oito cenários k6 que medem quanto a API suporta e provam que ela continua correta sob carga. Cobrem as duas entradas
do serviço: HTTP e a fila SQS.

## Pré-requisitos

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (testado com v2.2.0).
- Infraestrutura e API no ar, como em [STEPS.md](./STEPS.md):

```bash
bun run db:up && bun run migration:up
bun run start:bun            # em outro terminal
```

Os scripts leem `BASE_URL` (padrão `http://localhost:8080`), `SQS_ENDPOINT` (padrão `http://localhost:4566`) e
`SQS_QUEUE_URL` / `SQS_DLQ_URL` (padrões iguais aos do `.env.example`). Para sobrescrever: `k6 run -e BASE_URL=... ...`.

## Cenários

| Comando | O que faz | Critério de sucesso |
|---|---|---|
| `bun run load:smoke` | 1 VU por 30 s | p95 < 300 ms, 0 erros |
| `bun run load:spike` | 0 a 200 VUs em 10 s, segura 1 min, volta a 0 | p95 < 800 ms, p99 < 2 s, erros < 1%, API se recupera |
| `bun run load:stress` | degraus de 100 a 1200 req/s, 60 s cada | relata o maior degrau com p95 < 1 s; aborta se erros > 5% |
| `bun run load:soak` | 240 req/s por 10 min | p95 < 1 s em cada terço, erros < 0,5% |
| `bun run load:contention` | 50 VUs em 1 carteira, depois em 100 carteiras | erros < 1%; compara as duas latências |
| `bun run load:idempotency-http` | 25 cópias simultâneas da mesma chave, payloads divergentes, id externo reutilizado | exatamente 1 efeito por chave |
| `bun run load:sqs-burst` | 5000 mensagens em 50 carteiras, espera a fila esvaziar | fila drenada em até 5 min, DLQ vazia |
| `bun run load:idempotency-sqs` | 4 casos de duplicidade em 100 carteiras | 1 efeito por carteira, DLQ com exatamente 50 |

Os cenários que mexem em saldo terminam chamando `POST /wallets/:id/reconciliation` em todas as carteiras criadas. Uma
carteira inconsistente incrementa `integrity_failures` e reprova o cenário, não importa a latência.

A mistura das operações HTTP (spike, stress, soak): 60% `BET`, 20% `WIN`/`LOSS`, 5% `REFUND`/`ROLLBACK`, 15% leituras. Cerca de
2% das apostas vão para uma carteira com saldo `1.00` e apostam `25.00`, para o 422 (saldo insuficiente) acontecer de
propósito; 4xx esperados não entram em `http_req_failed`.

## Como ler o resultado

- Cada comando grava o resumo em `load/results/<cenário>.json` (ignorado pelo git). O terminal mostra os limites com ✓/✗.
- `integrity_failures` tem que ser `0`.
- **stress:** o código de saída 99 é esperado **somente se todas as linhas ✗ forem de `http_req_duration{step:N}`**: significa
  que algum degrau passou do limite de latência, ou seja, achou o limite. O maior degrau com ✓ é a vazão sustentada.
  Qualquer ✗ em `integrity_failures`, `checks` ou `http_req_failed` é falha real, não o limite esperado.
- **soak:** compare `http_req_duration{phase:first}` com `{phase:last}`. Uma alta clara indica degradação ao longo do tempo.
- **sqs-burst:** `sqs_drain_seconds` e `sqs_drain_msgs_per_sec` mostram a vazão do consumidor (inclui o tempo de envio).
- **idempotency-http:** `BREAK_IDEMPOTENCY=1 k6 run load/scenarios/idempotency-http.js` é um controle negativo. Ele
  quebra a idempotência de propósito e o cenário **tem que falhar**; se passar, os checks não provam nada.

## Fila suja

Os cenários SQS abortam no início se a fila principal ou a DLQ não estiverem vazias. A mensagem traz o comando:

```bash
docker exec jungle-localstack awslocal sqs purge-queue --queue-url <url>
```

O `idempotency-sqs` esvazia a DLQ no fim (as 50 mensagens conflitantes são esperadas).

## Atenção: o outbox acumula backlog

Cada transação processada grava eventos no outbox, e o publicador os envia para `wager-events.fifo`, que ninguém
consome neste ambiente. Sob carga sustentada a API grava mais rápido do que o publicador drena, então o backlog cresce
e a fila de eventos enche (depois da bateria completa: ~210 mil linhas pendentes no outbox e ~613 mil mensagens na
fila de eventos). Esse trabalho em segundo plano disputa CPU e banco com a API: um `load:spike` repetido logo depois da
bateria deu p95 de 4,6 s, contra 435 ms com o outbox vazio. Para resultados comparáveis, espere o outbox drenar
(`outbox_messages` com `published_at is null` em zero) e esvazie a fila de eventos antes de cada cenário.

## Resultados medidos (máquina de desenvolvimento)

Windows 11, API em `bun`, Postgres e LocalStack no Docker, k6 na mesma máquina. Valem como medida relativa, não como
capacidade de produção.

| Cenário | Resultado |
|---|---|
| smoke | p95 9,7 ms, 0 erros |
| spike (200 VUs) | ~660 req/s, p95 435 ms, p99 596 ms, 0 erros |
| stress | p95 14 ms a 100 e 200 req/s, 91 ms a 400, 458 ms a 600; **limite sustentado: 600 req/s**. Em 800, 1000 e 1200 o p95 passa de 1,4 s e a vazão real satura em ~520 req/s; 0 erros e `dropped_iterations` mostra o que o k6 não conseguiu enviar |
| soak (240 req/s, 10 min) | 144 mil requisições, 0 erros, p95 12,6 ms no 1º terço, 11,8 no 2º e 14,3 no último: estável |
| contention | 1 carteira: p95 851 ms (máx 2,1 s). 100 carteiras: p95 95 ms. O lock por carteira custa ~9x no p95 |
| idempotency-http | 200 chaves × 25 cópias simultâneas: sempre 1 efeito, 0 erros 5xx; payload divergente dá 409 |
| sqs-burst | 5000 mensagens drenadas em 79 s (~63 msg/s), DLQ vazia, 100 débitos por carteira |
| idempotency-sqs | 1 efeito por carteira nos 4 casos; DLQ com exatamente 50 mensagens |

### Calibração

Os limites de latência do design se mostraram adequados e não mudaram. Mudaram dois valores:

- **Degraus do stress:** o design partia de 400 req/s, mas a API sustentou 600. Os degraus passaram a `100, 200, 400, 600, 800, 1000, 1200` para o limite aparecer.
- **Taxa do soak:** `SOAK_RATE` padrão de 240 req/s (40% de 600). Pode ser sobrescrita com `-e SOAK_RATE=...`.

Os limites vivem em `load/lib/thresholds.js`.

## Observação sobre o SQS

O k6 fala com o SQS pelo protocolo JSON, sem assinatura (o LocalStack não verifica). Contra a AWS de verdade seria
preciso assinar as requisições. Cada envio usa `MessageDeduplicationId` próprio, senão a fila FIFO com
`ContentBasedDeduplication` descartaria as cópias antes de chegarem à aplicação.
