import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';

export async function runMigrations(
  db: pg.Pool,
  directory = resolve(process.cwd(), 'migrations'),
): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  );
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(72638491)');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const name of files) {
      try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [
          name,
        ]);
        if (existing.rowCount === 0) {
          await client.query(await readFile(resolve(directory, name), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(72638491)').catch(() => undefined);
    client.release();
  }
}
