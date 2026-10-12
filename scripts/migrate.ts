import { runMigrations } from '../src/shared/db/migrate.js';
import { createPool } from '../src/shared/db/pool.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations.');
const db = createPool(databaseUrl);
try {
  await runMigrations(db);
  console.info('Database migrations are up to date.');
} finally {
  await db.end();
}
