import { HttpException, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import type { ProblemFieldError } from '../problem.js';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly source: 'body' | 'query' | 'header' | 'path',
  ) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const errors: ProblemFieldError[] = result.error.issues.map((issue) => ({
      path: [this.source, ...issue.path.map(String)].join('.'),
      message: issue.message,
    }));
    throw new HttpException(
      {
        code: 'VALIDATION_ERROR',
        message: 'request validation failed',
        errors,
      },
      400,
    );
  }
}
