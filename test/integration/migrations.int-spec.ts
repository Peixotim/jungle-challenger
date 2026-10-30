import { connectTestDatabase, TestDatabase } from './support/database.js';

describe('migrations', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  const tables = async () =>
    (
      await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name <> 'schema_migrations'
          order by table_name`,
      )
    ).map((r) => r.table_name);

  it('apply cleanly and create every table', async () => {
    await db.reset();

    expect(await tables()).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });

  it('are reversible: down removes everything, up restores it', async () => {
    await db.reset();

    await db.orm.migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);
    const functions = await db.query(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );
    expect(functions).toEqual([]);

    await db.orm.migrator.up();
    expect(await tables()).toHaveLength(5);
  });
});
