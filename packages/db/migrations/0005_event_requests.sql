-- Reconstructed from the deployed production schema. Keep object names and
-- constraints identical so development and fresh databases match production.
DO $$ BEGIN
  CREATE TYPE "event_request_status" AS ENUM ('new', 'in_progress', 'closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "event_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "text" text NOT NULL,
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" "event_request_status" NOT NULL DEFAULT 'new',
  "assigned_to" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "event_requests_event_idx"
  ON "event_requests" USING btree ("event_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_requests_status_idx"
  ON "event_requests" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_requests_created_idx"
  ON "event_requests" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_requests_open_uidx"
  ON "event_requests" USING btree ("event_id", "user_id")
  WHERE "status" <> 'closed';
