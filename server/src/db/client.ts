import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema.js';

export function makeDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof makeDb>;

export async function migrateDb(db: Db): Promise<void> {
  // CWD-relative (not import.meta.url-relative): the server is bundled by tsup
  // into a single dist/index.js, so a URL relative to the source file would
  // resolve outside the package. The server always runs with CWD = server/
  // (dev, via pnpm --filter) or /app (Docker), where ./drizzle lives.
  await migrate(db, { migrationsFolder: './drizzle' });
}
