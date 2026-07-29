import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const { Pool } = pg;

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(databaseUrl: string, options?: { max?: number }) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options?.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
