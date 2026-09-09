CREATE TABLE "event_quick_answers" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_quick_answers_event_id_user_id_pk" PRIMARY KEY("event_id","user_id"),
	CONSTRAINT "event_quick_answers_text_check" CHECK (length(trim("event_quick_answers"."answer")) BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "export_jobs" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "scope" text DEFAULT 'event' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_messenger_identities" ADD COLUMN "first_bot_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_messenger_identities" ADD COLUMN "first_app_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_quick_answers" ADD CONSTRAINT "event_quick_answers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_quick_answers" ADD CONSTRAINT "event_quick_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_scope_check" CHECK (("export_jobs"."scope" IN ('event', 'quick_answers') AND "export_jobs"."event_id" IS NOT NULL) OR ("export_jobs"."scope" = 'users' AND "export_jobs"."event_id" IS NULL AND "export_jobs"."kind" = 'xlsx'));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'artifacts_app') THEN
    GRANT SELECT, INSERT, DELETE ON event_quick_answers TO artifacts_app;
  END IF;
END $$;
