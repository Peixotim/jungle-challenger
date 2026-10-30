import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20260101000001CreateSchema } from './migrations/Migration20260101000001CreateSchema.js';
import { Migration20260101000002IntegrityTriggers } from './migrations/Migration20260101000002IntegrityTriggers.js';

export const MIGRATIONS = [
  {
    name: 'Migration20260101000001CreateSchema',
    class: Migration20260101000001CreateSchema,
  },
  {
    name: 'Migration20260101000002IntegrityTriggers',
    class: Migration20260101000002IntegrityTriggers,
  },
];

export const MIGRATION_NAMES = MIGRATIONS.map((migration) => migration.name);

export const MIGRATIONS_TABLE = 'schema_migrations';

export function createOrmConfig(
  clientUrl: string,
  pool: { min: number; max: number } = { min: 2, max: 20 },
) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool,
    migrations: {
      tableName: MIGRATIONS_TABLE,
      silent: true,
      snapshot: false,
      snapshotOnMigrate: false,
      transactional: true,
      allOrNothing: true,
      migrationsList: MIGRATIONS,
    },
  });
}
