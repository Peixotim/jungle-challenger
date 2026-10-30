import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/MikroOrmUnitOfWork.js';

const DEFAULT_URL = 'postgresql://jungle:jungle@localhost:5432/jungle_test';

export const testDatabaseUrl = (): string =>
  process.env.TEST_DATABASE_URL ?? DEFAULT_URL;

export interface TestDatabase {
  orm: MikroORM;
  uow: MikroOrmUnitOfWork;
  reset(): Promise<void>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

function assertTestDatabase(url: string): string {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+$/i.test(name) || !name.endsWith('_test')) {
    throw new Error(
      `refusing to run destructive integration tests on database "${name}": its name must end with _test`,
    );
  }
  return name;
}

async function ensureDatabase(url: string): Promise<void> {
  const name = assertTestDatabase(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const orm = await MikroORM.init({
    clientUrl: admin.toString(),
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: 1 },
  });
  try {
    const existing = await orm.em.execute(
      'select 1 from pg_database where datname = ?',
      [name],
    );
    if (existing.length === 0) await orm.em.execute(`create database ${name}`);
  } finally {
    await orm.close();
  }
}

export async function connectTestDatabase(url?: string): Promise<TestDatabase> {
  if (url === undefined) {
    url = testDatabaseUrl();
    await ensureDatabase(url);
  } else {
    assertTestDatabase(url);
  }
  const orm = await MikroORM.init(createOrmConfig(url));
  const uow = new MikroOrmUnitOfWork(orm.em);
  return {
    orm,
    uow,
    async reset() {
      await orm.migrator.down({ to: 0 });
      await orm.migrator.up();
    },
    query: (sql, params) => orm.em.fork().execute(sql, params ?? []),
    close: () => orm.close(),
  };
}
