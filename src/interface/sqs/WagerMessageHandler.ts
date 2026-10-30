import { Inject } from '@nestjs/common';
import { Logger } from '../../application/ports/Logger.js';
import { Metrics } from '../../application/ports/Metrics.js';
import {
  MessageAction,
  MessageOutcomePolicy,
} from '../../application/services/MessageOutcomePolicy.js';
import { SubmitWagerTransaction } from '../../application/use-cases/SubmitWagerTransaction.js';
import { WagerTransactionKind } from '../../domain/wagering/enums/WagerTransactionKind.js';
import { requestContext } from '../../infrastructure/observability/request-context.js';
import { wagerMessageEnvelope } from './schemas.js';

export const WAGER_CONSUMER_NAME = 'wager-transactions';

export interface InboundMessage {
  body: string;
  receiveCount: number;
}

export class WagerMessageHandler {
  constructor(
    @Inject(SubmitWagerTransaction)
    private readonly submit: SubmitWagerTransaction,
    @Inject(MessageOutcomePolicy)
    private readonly policy: MessageOutcomePolicy,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(Logger) private readonly logger: Logger,
  ) {}

  async handle(message: InboundMessage): Promise<MessageAction> {
    const envelope = this.parse(message.body);
    if (!envelope.ok) return { kind: 'dead-letter', reason: 'MALFORMED' };

    const { messageId, data } = envelope.value;
    return requestContext.run({ correlationId: messageId }, async () => {
      try {
        const result = await this.submit.execute({
          ...data,
          kind: data.kind as WagerTransactionKind,
          correlationId: messageId,
          source: { consumerName: WAGER_CONSUMER_NAME, messageId },
        });
        this.logger.info('wager message processed', {
          messageId,
          transactionId: result.transactionId,
          walletId: data.walletId,
          providerId: data.providerId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        });
        return { kind: 'ack' } as const;
      } catch (error) {
        const action = this.policy.decide(error, message.receiveCount);
        this.logger.warn('wager message failed', {
          messageId,
          walletId: data.walletId,
          providerId: data.providerId,
          receiveCount: message.receiveCount,
          action: action.kind,
          err: error,
        });
        return action;
      }
    });
  }

  private parse(body: string) {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      this.metrics.increment('sqs_malformed_messages_total', {
        cause: 'json',
      });
      this.logger.warn('malformed wager message: body is not JSON');
      return { ok: false } as const;
    }
    const parsed = wagerMessageEnvelope.safeParse(json);
    if (!parsed.success) {
      this.metrics.increment('sqs_malformed_messages_total', {
        cause: 'schema',
      });
      this.logger.warn('malformed wager message: schema violation', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
      return { ok: false } as const;
    }
    return { ok: true, value: parsed.data } as const;
  }
}
