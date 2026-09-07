CREATE TABLE "coworking_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"attendees" integer NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"reviewed_by" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coworking_booking_status_check" CHECK ("coworking_bookings"."status" IN ('pending','confirmed','rejected','cancelled')),
	CONSTRAINT "coworking_booking_attendees_check" CHECK ("coworking_bookings"."attendees" BETWEEN 1 AND 20),
	CONSTRAINT "coworking_booking_duration_check" CHECK ("coworking_bookings"."ends_at" >= "coworking_bookings"."starts_at" + interval '30 minutes' AND "coworking_bookings"."ends_at" <= "coworking_bookings"."starts_at" + interval '8 hours')
);

--> statement-breakpoint
ALTER TABLE "coworking_bookings" ADD CONSTRAINT "coworking_bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "coworking_bookings" ADD CONSTRAINT "coworking_bookings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "coworking_booking_user_key_uq" ON "coworking_bookings" USING btree ("user_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "coworking_booking_user_idx" ON "coworking_bookings" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "coworking_booking_status_idx" ON "coworking_bookings" USING btree ("status","created_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'artifacts_app') THEN
    GRANT SELECT, INSERT, UPDATE ON coworking_bookings TO artifacts_app;
  END IF;
END $$;
