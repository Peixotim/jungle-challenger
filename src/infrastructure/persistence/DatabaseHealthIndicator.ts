import { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Inject } from '@nestjs/common';
import { HealthIndicator } from '../../application/ports/HealthIndicator.js';

export class DatabaseHealthIndicator extends HealthIndicator {
  readonly name = 'postgres';

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {
    super();
  }

  async check(): Promise<void> {
    await (this.orm.em.fork() as unknown as EntityManager).execute('select 1');
  }
}
