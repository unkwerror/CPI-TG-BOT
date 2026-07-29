CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint
CREATE TYPE "user_status" AS ENUM ('active', 'blocked');
--> statement-breakpoint
CREATE TYPE "role_name" AS ENUM ('participant', 'admin', 'superadmin');
--> statement-breakpoint
CREATE TYPE "event_status" AS ENUM ('draft', 'published', 'running', 'finished', 'archived');
--> statement-breakpoint
CREATE TYPE "event_format" AS ENUM ('offline', 'online', 'hybrid');
--> statement-breakpoint
CREATE TYPE "submission_status" AS ENUM ('draft', 'processing', 'ready', 'failed', 'deleted');
--> statement-breakpoint
CREATE TYPE "artifact_status" AS ENUM ('created', 'uploading', 'uploaded', 'verifying', 'ready', 'failed', 'quarantined', 'deleted');
--> statement-breakpoint
CREATE TYPE "artifact_kind" AS ENUM ('file', 'image', 'document', 'audio', 'video', 'archive');
--> statement-breakpoint
CREATE TYPE "export_status" AS ENUM ('queued', 'processing', 'ready', 'failed', 'expired');
--> statement-breakpoint
CREATE TYPE "export_kind" AS ENUM ('csv', 'xlsx', 'zip');
--> statement-breakpoint

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "telegram_user_id" bigint NOT NULL,
  "telegram_username" text,
  "telegram_first_name" text,
  "telegram_last_name" text,
  "telegram_language_code" text,
  "full_name" text,
  "organization" text,
  "position" text,
  "phone" text,
  "avatar_url" text,
  "consent_at" timestamptz,
  "status" "user_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "users_telegram_user_id_unique" UNIQUE ("telegram_user_id")
);
--> statement-breakpoint
CREATE INDEX "users_username_idx" ON "users" ("telegram_username");
--> statement-breakpoint
CREATE INDEX "users_last_seen_idx" ON "users" ("last_seen_at");
--> statement-breakpoint

CREATE TABLE "roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" "role_name" NOT NULL,
  "description" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "roles_name_unique" UNIQUE ("name")
);
--> statement-breakpoint

CREATE TABLE "user_roles" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "scope_event_id" uuid,
  "assigned_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY ("user_id", "role_id")
);
--> statement-breakpoint
CREATE INDEX "user_roles_scope_idx" ON "user_roles" ("scope_event_id");
--> statement-breakpoint

CREATE TABLE "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "slug" text NOT NULL,
  "short_code" text NOT NULL,
  "description" text,
  "organizer" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "timezone" text DEFAULT 'Asia/Novosibirsk' NOT NULL,
  "venue" text,
  "city" text,
  "format" "event_format" DEFAULT 'offline' NOT NULL,
  "status" "event_status" DEFAULT 'draft' NOT NULL,
  "tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "search_text" text DEFAULT '' NOT NULL,
  "cover_url" text,
  "accept_uploads_from" timestamptz NOT NULL,
  "accept_uploads_until" timestamptz NOT NULL,
  "max_file_size_bytes" bigint DEFAULT 524288000 NOT NULL,
  "allowed_mime_types" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "blocked_extensions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "direct_access_enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz,
  CONSTRAINT "events_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "events_short_code_unique" UNIQUE ("short_code"),
  CONSTRAINT "events_date_order_check" CHECK ("ends_at" >= "starts_at"),
  CONSTRAINT "events_acceptance_order_check" CHECK ("accept_uploads_until" >= "accept_uploads_from"),
  CONSTRAINT "events_max_file_size_positive_check" CHECK ("max_file_size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_scope_event_id_events_id_fk"
  FOREIGN KEY ("scope_event_id") REFERENCES "events"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "events_status_dates_idx" ON "events" ("status", "starts_at");
--> statement-breakpoint
CREATE INDEX "events_city_idx" ON "events" ("city");
--> statement-breakpoint
CREATE INDEX "events_acceptance_idx" ON "events" ("accept_uploads_from", "accept_uploads_until");
--> statement-breakpoint
CREATE INDEX "events_search_trgm_idx" ON "events" USING gin ("search_text" gin_trgm_ops);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_event_search_text() RETURNS trigger AS $$
BEGIN
  NEW.search_text = concat_ws(
    ' ',
    NEW.title,
    NEW.organizer,
    NEW.city,
    NEW.short_code,
    array_to_string(NEW.tags, ' ')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER events_set_search_text
  BEFORE INSERT OR UPDATE OF title, organizer, city, short_code, tags ON "events"
  FOR EACH ROW EXECUTE FUNCTION set_event_search_text();
--> statement-breakpoint

CREATE TABLE "event_tags" (
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "tag" text NOT NULL,
  CONSTRAINT "event_tags_event_id_tag_pk" PRIMARY KEY ("event_id", "tag")
);
--> statement-breakpoint
CREATE INDEX "event_tags_tag_idx" ON "event_tags" ("tag");
--> statement-breakpoint

CREATE TABLE "event_participants" (
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source" text DEFAULT 'opened' NOT NULL,
  "joined_at" timestamptz DEFAULT now() NOT NULL,
  "last_submission_at" timestamptz,
  CONSTRAINT "event_participants_event_id_user_id_pk" PRIMARY KEY ("event_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "event_participants_user_idx" ON "event_participants" ("user_id");
--> statement-breakpoint

CREATE TABLE "submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "title" text,
  "text" text,
  "link" text,
  "status" "submission_status" DEFAULT 'draft' NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "submitted_at" timestamptz,
  "deleted_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_user_idempotency_uq" ON "submissions" ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "submissions_event_created_idx" ON "submissions" ("event_id", "created_at");
--> statement-breakpoint
CREATE INDEX "submissions_user_created_idx" ON "submissions" ("user_id", "created_at");
--> statement-breakpoint

CREATE TABLE "artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "submission_id" uuid NOT NULL REFERENCES "submissions"("id") ON DELETE RESTRICT,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "kind" "artifact_kind" DEFAULT 'file' NOT NULL,
  "original_name" text NOT NULL,
  "display_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "extension" text DEFAULT '' NOT NULL,
  "size_bytes" bigint NOT NULL,
  "actual_size_bytes" bigint,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "upload_id" text,
  "checksum_sha256" text,
  "etag" text,
  "status" "artifact_status" DEFAULT 'created' NOT NULL,
  "status_reason" text,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "ready_at" timestamptz,
  "deleted_at" timestamptz,
  CONSTRAINT "artifacts_object_key_unique" UNIQUE ("object_key"),
  CONSTRAINT "artifacts_size_positive_check" CHECK ("size_bytes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_user_idempotency_uq" ON "artifacts" ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "artifacts_submission_idx" ON "artifacts" ("submission_id");
--> statement-breakpoint
CREATE INDEX "artifacts_event_status_idx" ON "artifacts" ("event_id", "status");
--> statement-breakpoint
CREATE INDEX "artifacts_user_created_idx" ON "artifacts" ("user_id", "created_at");
--> statement-breakpoint

CREATE TABLE "upload_parts" (
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "part_number" integer NOT NULL,
  "etag" text NOT NULL,
  "size_bytes" bigint,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "upload_parts_artifact_id_part_number_pk" PRIMARY KEY ("artifact_id", "part_number"),
  CONSTRAINT "upload_parts_part_number_check" CHECK ("part_number" >= 1 AND "part_number" <= 10000)
);
--> statement-breakpoint

CREATE TABLE "export_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "kind" "export_kind" NOT NULL,
  "status" "export_status" DEFAULT 'queued' NOT NULL,
  "progress" integer DEFAULT 0 NOT NULL,
  "bucket" text,
  "object_key" text,
  "size_bytes" bigint,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "expires_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "export_jobs_event_created_idx" ON "export_jobs" ("event_id", "created_at");
--> statement-breakpoint
CREATE INDEX "export_jobs_status_idx" ON "export_jobs" ("status");
--> statement-breakpoint

CREATE TABLE "audit_logs" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "event_id" uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "ip_address" text,
  "user_agent" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" ("actor_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "audit_logs_event_created_idx" ON "audit_logs" ("event_id", "created_at");
--> statement-breakpoint

CREATE TABLE "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_type_aggregate_uq" ON "outbox_events" ("type", "aggregate_type", "aggregate_id");
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" ("processed_at", "available_at");
--> statement-breakpoint

CREATE TABLE "notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "deduplication_key" text NOT NULL,
  "telegram_message_id" bigint,
  "delivered_at" timestamptz,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "notification_deliveries_deduplication_key_unique" UNIQUE ("deduplication_key")
);
--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_idx" ON "notification_deliveries" ("user_id", "created_at");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER events_set_updated_at BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER submissions_set_updated_at BEFORE UPDATE ON "submissions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER artifacts_set_updated_at BEFORE UPDATE ON "artifacts"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
