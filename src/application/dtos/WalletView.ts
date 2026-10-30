import { MoneyProps } from '../../domain/money/dtos/MoneyProps.js';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}
