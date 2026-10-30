import { MoneyProps } from '../../domain/money/dtos/MoneyProps.js';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}
