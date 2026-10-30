import { InvalidMessageStateError } from '../../errors/domain-errors.js';
import {
  InboxMessageState,
  ReceiveInboxProps,
} from '../dtos/InboxMessageState.js';

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.trim() === '' || props.consumerName.trim() === '') {
      throw new InvalidMessageStateError(
        'messageId and consumerName are required',
      );
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(
        `inbox message ${this.messageId} already processed`,
      );
    }
    this._processedAt = at;
  }
}
