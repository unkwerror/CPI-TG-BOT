import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const { db, pool } = createDatabase(databaseUrl, { max: 1 });
const migrationsFolder =
  process.env.MIGRATIONS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

try {
  await migrate(db, { migrationsFolder });
  process.stdout.write('Database migrations completed\n');
} finally {
  await pool.end();
}
