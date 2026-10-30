import { Wallet } from '../../domain/wallet/model/Wallet.js';

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | undefined>;

  abstract findByIdForUpdate(id: string): Promise<Wallet | undefined>;

  abstract insertIfAbsent(wallet: Wallet): Promise<boolean>;

  abstract save(wallet: Wallet): Promise<void>;
}
