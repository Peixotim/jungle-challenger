import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CreateWallet } from '../../../application/use-cases/CreateWallet.js';
import { GetWallet } from '../../../application/use-cases/GetWallet.js';
import { GetWalletLedger } from '../../../application/use-cases/GetWalletLedger.js';
import { ReconcileWallet } from '../../../application/use-cases/ReconcileWallet.js';
import { requestContext } from '../../../infrastructure/observability/request-context.js';
import { createWalletBody, ledgerQuery } from '../validation/schemas.js';
import type { CreateWalletBody, LedgerQuery } from '../validation/schemas.js';
import { ZodPipe } from '../validation/ZodPipe.js';
import { randomUUID } from 'node:crypto';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(GetWalletLedger) private readonly getLedger: GetWalletLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  create(@Body(new ZodPipe(createWalletBody, 'body')) body: CreateWalletBody) {
    return this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId: requestContext.correlationId() ?? randomUUID(),
    });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query(new ZodPipe(ledgerQuery, 'query')) query: LedgerQuery,
  ) {
    return this.getLedger.execute(walletId, query);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.reconcileWallet.execute(walletId);
  }
}
