import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { GetWagerTransaction } from '../../../application/use-cases/GetWagerTransaction.js';
import { SubmitWagerTransaction } from '../../../application/use-cases/SubmitWagerTransaction.js';
import { WagerTransactionKind } from '../../../domain/wagering/enums/WagerTransactionKind.js';
import { requestContext } from '../../../infrastructure/observability/request-context.js';
import { httpStatusFor } from '../presenters/submit-status.js';
import {
  idempotencyKeyHeader,
  submitTransactionBody,
} from '../validation/schemas.js';
import type { SubmitTransactionBody } from '../validation/schemas.js';
import { ZodPipe } from '../validation/ZodPipe.js';

const idempotencyKeyPipe = new ZodPipe(idempotencyKeyHeader, 'header');

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction)
    private readonly submitTransaction: SubmitWagerTransaction,
    @Inject(GetWagerTransaction)
    private readonly getTransaction: GetWagerTransaction,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body(new ZodPipe(submitTransactionBody, 'body'))
    body: SubmitTransactionBody,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(
      headers['idempotency-key'],
    );
    const result = await this.submitTransaction.execute({
      ...body,
      kind: body.kind as WagerTransactionKind,
      idempotencyKey,
      correlationId: requestContext.correlationId() ?? randomUUID(),
    });
    response.status(httpStatusFor(result.status));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}
