import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);
const migrationPath = path.join(migrationsDirectory, '0000_initial.sql');

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

  it('keeps migrations in strictly increasing journal order', async () => {
    const journal = JSON.parse(
      await readFile(path.join(migrationsDirectory, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };

    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    }
  });

  it('can safely recover a schema after an earlier migration was skipped', async () => {
    const recovery = await readFile(
      path.join(migrationsDirectory, '0006_crm_sync_state_recovery.sql'),
      'utf8',
    );
    expect(recovery).toContain('ADD COLUMN IF NOT EXISTS "crm_pending_review_at"');
    expect(recovery).toContain('CREATE INDEX IF NOT EXISTS "submissions_crm_unsynced_idx"');
    expect(recovery).toContain('ON CONFLICT ("type", "aggregate_type", "aggregate_id")');
  });

  it('restores the production event request history before wallet changes', async () => {
    const flagMigration = await readFile(
      path.join(migrationsDirectory, '0004_event_requests_flag.sql'),
      'utf8',
    );
    const requestMigration = await readFile(
      path.join(migrationsDirectory, '0005_event_requests.sql'),
      'utf8',
    );

    expect(flagMigration).toContain(
      'ADD COLUMN IF NOT EXISTS "accepts_requests" boolean NOT NULL DEFAULT false',
    );
    expect(requestMigration).toContain(
      "CREATE TYPE \"event_request_status\" AS ENUM ('new', 'in_progress', 'closed')",
    );
    expect(requestMigration).toContain('CREATE TABLE IF NOT EXISTS "event_requests"');
    expect(requestMigration).toContain('"attachments" jsonb NOT NULL DEFAULT \'[]\'::jsonb');
    expect(requestMigration).toContain('"event_requests_open_uidx"');
    expect(requestMigration).toContain('WHERE "status" <> \'closed\'');
  });

  it('bootstraps an auditable point program without seeding an unknown reward', async () => {
    const walletMigration = await readFile(
      path.join(migrationsDirectory, '0007_wallet_platform.sql'),
      'utf8',
    );

    expect(walletMigration).toContain('"welcome_amount" bigint NOT NULL DEFAULT 100');
    expect(walletMigration).toContain('"max_transaction_amount" bigint NOT NULL DEFAULT 100000');
    expect(walletMigration).toContain('"qr_ttl_seconds" integer NOT NULL DEFAULT 120');
    expect(walletMigration).toContain(
      "'welcome:' || selected_program_id::text || ':' || NEW.id::text",
    );
    expect(walletMigration).toContain('"users_bootstrap_default_wallet_trigger"');
    expect(walletMigration).not.toContain('INSERT INTO "event_reward_policies"');
  });

  it('seals and validates double-entry transactions before making them immutable', async () => {
    const walletMigration = await readFile(
      path.join(migrationsDirectory, '0007_wallet_platform.sql'),
      'utf8',
    );

    expect(walletMigration).toContain('"sealed_at" timestamp with time zone');
    expect(walletMigration).toContain('"ledger_entries_before_seal_trigger"');
    expect(walletMigration).toContain('"ledger_transactions_integrity_trigger"');
    expect(walletMigration).toContain('"ledger_entries_integrity_trigger"');
    expect(walletMigration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(walletMigration).toContain('IF transaction_sealed_at IS NULL THEN');
    expect(walletMigration).toContain('IF entry_count < 2 OR entry_sum <> 0 THEN');
    expect(walletMigration).toContain('IF mismatched_account_count > 0 THEN');
    expect(walletMigration).toContain('OLD."sealed_at" IS NULL');
    expect(walletMigration).toContain('NEW."sealed_at" IS NOT NULL');
    expect(walletMigration).toContain('SET "sealed_at" = now()');
    expect(walletMigration).toContain('"ledger_entries_immutable_trigger"');
  });

  it('enforces lifetime rewards, fund access and immutable paid orders', async () => {
    const walletMigration = await readFile(
      path.join(migrationsDirectory, '0007_wallet_platform.sql'),
      'utf8',
    );

    expect(walletMigration).toContain(
      'CONSTRAINT "event_reward_claims_event_user_uq" UNIQUE ("event_id", "user_id")',
    );
    expect(walletMigration).toContain(
      'CONSTRAINT "point_fund_access_program_user_uq" UNIQUE ("program_id", "user_id")',
    );
    expect(walletMigration).toContain(
      "CREATE TYPE \"store_order_status\" AS ENUM ('paid', 'pickup_requested', 'ready_for_pickup', 'fulfilled')",
    );
    expect(walletMigration).not.toContain("'refunded'");
  });

  it('adds foreign keys for every nullable bridge to the new domain', async () => {
    const walletMigration = await readFile(
      path.join(migrationsDirectory, '0007_wallet_platform.sql'),
      'utf8',
    );

    for (const constraint of [
      'point_programs_active_season_id_point_seasons_id_fk',
      'events_active_form_version_id_event_form_versions_id_fk',
      'submissions_form_version_id_event_form_versions_id_fk',
      'artifacts_form_field_id_event_artifact_fields_id_fk',
      'ledger_transactions_related_order_id_store_orders_id_fk',
      'ledger_transactions_reversal_of_transaction_id_ledger_transactions_id_fk',
    ]) {
      expect(walletMigration).toContain(constraint);
    }
  });

  it('keeps a complete latest Drizzle snapshot for future generation', async () => {
    const previous = JSON.parse(
      await readFile(path.join(migrationsDirectory, 'meta/0001_snapshot.json'), 'utf8'),
    ) as { id: string };
    const latest = JSON.parse(
      await readFile(path.join(migrationsDirectory, 'meta/0007_snapshot.json'), 'utf8'),
    ) as {
      prevId: string;
      tables: Record<string, { columns?: Record<string, unknown> }>;
      enums: Record<string, unknown>;
    };

    expect(latest.prevId).toBe(previous.id);
    for (const table of [
      'public.event_requests',
      'public.point_programs',
      'public.ledger_transactions',
      'public.event_reward_claims',
      'public.store_orders',
      'public.feed_posts',
    ]) {
      expect(latest.tables).toHaveProperty(table);
    }
    expect(latest.tables['public.ledger_transactions']?.columns).toHaveProperty('sealed_at');
    expect(latest.enums).toHaveProperty('public.wallet_intent_status');
  });

  it('adds pending product media uploads without breaking legacy URL rows', async () => {
    const migration = await readFile(
      path.join(migrationsDirectory, '0008_store_product_media_uploads.sql'),
      'utf8',
    );
    const snapshot = JSON.parse(
      await readFile(path.join(migrationsDirectory, 'meta/0008_snapshot.json'), 'utf8'),
    ) as {
      tables: Record<string, { columns?: Record<string, unknown> }>;
    };

    expect(migration).toContain(
      'ALTER TABLE "store_product_media" ALTER COLUMN "url" DROP NOT NULL',
    );
    expect(migration).toContain('ADD COLUMN "upload_status"');
    expect(migration).toContain("IN ('pending', 'ready')");
    expect(snapshot.tables['public.store_product_media']?.columns).toHaveProperty('bucket');
    expect(snapshot.tables['public.store_product_media']?.columns).toHaveProperty('upload_status');
  });

  it('adds an idempotent Leader-ID registry, bindings and lifetime reward grant', async () => {
    const migration = await readFile(
      path.join(migrationsDirectory, '0018_tearful_ultimatum.sql'),
      'utf8',
    );
    const snapshot = JSON.parse(
      await readFile(path.join(migrationsDirectory, 'meta/0018_snapshot.json'), 'utf8'),
    ) as { tables: Record<string, { columns?: Record<string, unknown> }> };

    expect(migration).toContain("ADD VALUE 'leader_id_subscription_reward'");
    expect(migration).toContain('CREATE TABLE "leader_id_bindings"');
    expect(migration).toContain('CREATE TABLE "leader_id_event_registrations"');
    expect(migration).toContain('CREATE TABLE "leader_id_reward_grants"');
    expect(migration).toContain('"leader_id_event_registrations_user_event_uq"');
    expect(migration).toContain('"leader_id_reward_grants_user_reason_uq"');
    expect(migration).toContain("= 'LEADER_ID_CATALYST_SUBSCRIPTION'");
    expect(migration).not.toContain('CHECK ("leader_id_reward_grants"."reason" = $1)');
    expect(migration).toContain('"leader_id_subscription_reward" bigint DEFAULT 0 NOT NULL');
    expect(migration).toContain("'LID_606466'");
    expect(migration).toContain('\t606466,');
    expect(snapshot.tables).toHaveProperty('public.leader_id_bindings');
    expect(snapshot.tables).toHaveProperty('public.leader_id_event_registrations');
    expect(snapshot.tables).toHaveProperty('public.leader_id_reward_grants');
    expect(snapshot.tables['public.events']?.columns).toHaveProperty('leader_id_event_id');
  });

  it('keeps the configured Leader-ID event aligned with the official online venue', async () => {
    const migration = await readFile(
      path.join(migrationsDirectory, '0019_correct_leader_event_606466.sql'),
      'utf8',
    );

    expect(migration).toContain('WHERE "leader_id_event_id" = 606466');
    expect(migration).toContain('Точки кипения — Новосибирск');
    expect(migration).toContain('"format" = \'online\'');
  });
});
