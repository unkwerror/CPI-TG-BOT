import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations/0000_initial.sql',
);

describe('database invariants', () => {
  it('prevents duplicate Telegram users and event participants', async () => {
    const migration = await readFile(migrationPath, 'utf8');
    expect(migration).toContain('UNIQUE ("telegram_user_id")');
    expect(migration).toContain('PRIMARY KEY ("event_id", "user_id")');
  });

  it('enforces idempotency and artifact ownership relationships', async () => {
    const migration = await readFile(migrationPath, 'utf8');
    expect(migration).toContain('CREATE UNIQUE INDEX "submissions_user_idempotency_uq"');
    expect(migration).toContain('CREATE UNIQUE INDEX "artifacts_user_idempotency_uq"');
    expect(migration).toContain('"submission_id" uuid NOT NULL REFERENCES "submissions"("id")');
    expect(migration).toContain('"event_id" uuid NOT NULL REFERENCES "events"("id")');
    expect(migration).toContain('"user_id" uuid NOT NULL REFERENCES "users"("id")');
  });

  it('includes trigram search and an outbox uniqueness guard', async () => {
    const migration = await readFile(migrationPath, 'utf8');
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    expect(migration).toContain('events_search_trgm_idx');
    expect(migration).toContain('outbox_type_aggregate_uq');
  });
});
