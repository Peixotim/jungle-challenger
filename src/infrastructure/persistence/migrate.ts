import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './mikro-orm.config.js';

const DEFAULT_URL = 'postgresql://jungle:jungle@localhost:5432/jungle';
const COMMANDS = ['up', 'down', 'status'] as const;
type Command = (typeof COMMANDS)[number];

async function main(command: Command): Promise<void> {
  const orm = await MikroORM.init(
    createOrmConfig(process.env.DATABASE_URL ?? DEFAULT_URL),
  );
  try {
    if (command === 'up') {
      const applied = await orm.migrator.up();
      console.log(`applied ${applied.length} migration(s)`);
    } else if (command === 'down') {
      const reverted = await orm.migrator.down();
      console.log(`reverted ${reverted.length} migration(s)`);
    } else {
      const pending = await orm.migrator.getPending();
      const executed = await orm.migrator.getExecuted();
      console.log(`executed: ${executed.map((m) => m.name).join(', ') || '-'}`);
      console.log(`pending: ${pending.map((m) => m.name).join(', ') || '-'}`);
    }
  } finally {
    await orm.close();
  }
}

const command = process.argv[2] as Command | undefined;
if (!command || !COMMANDS.includes(command)) {
  console.error(`usage: migrate.ts <${COMMANDS.join('|')}>`);
  process.exit(1);
}
main(command).catch((error) => {
  console.error(error);
  process.exit(1);
});
