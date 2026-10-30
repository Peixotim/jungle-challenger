import { ArgumentsHost, Catch, ExceptionFilter, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Logger } from '../../../application/ports/Logger.js';
import { requestContext } from '../../../infrastructure/observability/request-context.js';
import { toProblem } from '../problem.js';

const RETRY_AFTER_SECONDS = '1';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(Logger) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const problem = toProblem(exception, requestContext.correlationId());
    if (problem.status >= 500) {
      this.logger.error('request failed', {
        method: request.method,
        path: request.path,
        status: problem.status,
        code: problem.code,
        err: exception,
      });
    }
    if (response.headersSent) return;
    if (problem.status === 503)
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    response
      .status(problem.status)
      .type('application/problem+json')
      .send(JSON.stringify(problem));
  }
}
