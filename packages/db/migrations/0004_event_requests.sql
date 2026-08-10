CREATE TYPE "event_request_status" AS ENUM('new', 'in_progress', 'closed');
--> statement-breakpoint

ALTER TABLE "events"
  ADD COLUMN "accepts_requests" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

CREATE TABLE "event_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "event_request_status" DEFAULT 'new' NOT NULL,
	"assigned_to" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "event_requests"
  ADD CONSTRAINT "event_requests_event_id_events_id_fk"
  FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "event_requests"
  ADD CONSTRAINT "event_requests_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "event_requests"
  ADD CONSTRAINT "event_requests_assigned_to_users_id_fk"
  FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "event_requests_created_idx" ON "event_requests" USING btree ("created_at", "id");
--> statement-breakpoint

CREATE INDEX "event_requests_status_idx" ON "event_requests" USING btree ("status", "created_at");
--> statement-breakpoint

CREATE INDEX "event_requests_event_idx" ON "event_requests" USING btree ("event_id", "created_at");
--> statement-breakpoint

-- Повторное обращение по тому же мероприятию дописывается в открытый запрос,
-- поэтому открытым он может быть только один.
CREATE UNIQUE INDEX "event_requests_open_uidx" ON "event_requests" USING btree ("event_id", "user_id")
  WHERE "status" <> 'closed';
