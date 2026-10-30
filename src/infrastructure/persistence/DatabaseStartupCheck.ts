import { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Inject, OnApplicationBootstrap } from '@nestjs/common';
import { Logger } from '../../application/ports/Logger.js';
import { APP_CONFIG } from '../../config/app-config.js';
import type { AppConfig } from '../../config/app-config.js';
import { MIGRATION_NAMES, MIGRATIONS_TABLE } from './mikro-orm.config.js';

export class DatabaseStartupCheck implements OnApplicationBootstrap {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Logger) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const em = this.orm.em.fork() as unknown as EntityManager;
    await em.execute('select 1');

    if (this.config.database.requireMigrated) {
      const pending = await this.pendingMigrations(em);
      if (pending.length > 0) {
        throw new Error(
          `database schema is not up to date; pending migrations: ${pending.join(', ')}. Run "bun run migration:up" before starting.`,
        );
      }
    }
    this.logger.info('database ready', {
      migrationsChecked: this.config.database.requireMigrated,
    });
  }

  private async pendingMigrations(em: EntityManager): Promise<string[]> {
    let executed: Set<string>;
    try {
      const rows = await em.execute<{ name: string }[]>(
        `select name from ${MIGRATIONS_TABLE}`,
      );
      executed = new Set(rows.map((row) => row.name));
    } catch {
      executed = new Set();
    }
    return MIGRATION_NAMES.filter((name) => !executed.has(name));
  }
}
