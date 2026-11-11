/** Executor de migrações versionadas (idempotente, cada migração em uma transação). */
import type { Database } from './db';
import * as m001 from './migrations/001_init';

export const MIGRATIONS: Array<{ version: string; sql: string }> = [m001];

export async function migrate(db: Database, log: (msg: string) => void = console.log): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const done: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.tx(async (c) => {
      await c.query(m.sql);
      await c.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
    });
    log(`[migrate] aplicada ${m.version}`);
    done.push(m.version);
  }
  return done;
}
