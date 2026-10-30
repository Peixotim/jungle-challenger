import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20260101000001CreateSchema } from './migrations/Migration20260101000001CreateSchema.js';
import { Migration20260101000002IntegrityTriggers } from './migrations/Migration20260101000002IntegrityTriggers.js';

export function createOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 2, max: 20 },
    migrations: {
      tableName: 'schema_migrations',
      silent: true,
      snapshot: false,
      snapshotOnMigrate: false,
      transactional: true,
      allOrNothing: true,
      migrationsList: [
        {
          name: 'Migration20260101000001CreateSchema',
          class: Migration20260101000001CreateSchema,
        },
        {
          name: 'Migration20260101000002IntegrityTriggers',
          class: Migration20260101000002IntegrityTriggers,
        },
      ],
    },
  });
}
