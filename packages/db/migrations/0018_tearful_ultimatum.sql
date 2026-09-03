ALTER TYPE "public"."ledger_transaction_kind" ADD VALUE 'leader_id_subscription_reward' BEFORE 'store_purchase';--> statement-breakpoint
CREATE TABLE "leader_id_bindings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"leader_id_user_id" bigint NOT NULL,
	"encrypted_tokens" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_id_bindings_external_user_check" CHECK ("leader_id_bindings"."leader_id_user_id" > 0 AND "leader_id_bindings"."leader_id_user_id" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "leader_id_event_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"leader_id_user_id" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"leader_id_event_id" bigint NOT NULL,
	"status" text NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"official_participation_id" text,
	"official_moderation" text,
	"error_code" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempt_claim_token" uuid,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_id_event_registrations_external_user_check" CHECK ("leader_id_event_registrations"."leader_id_user_id" > 0 AND "leader_id_event_registrations"."leader_id_user_id" <= 9007199254740991),
	CONSTRAINT "leader_id_event_registrations_external_event_check" CHECK ("leader_id_event_registrations"."leader_id_event_id" > 0 AND "leader_id_event_registrations"."leader_id_event_id" <= 9007199254740991),
	CONSTRAINT "leader_id_event_registrations_status_check" CHECK ("leader_id_event_registrations"."status" IN ('REGISTERED', 'ALREADY_REGISTERED', 'PENDING_APPROVAL', 'QUESTIONNAIRE_REQUIRED', 'REGISTRATION_CLOSED', 'EVENT_NOT_AVAILABLE', 'FAILED')),
	CONSTRAINT "leader_id_event_registrations_moderation_check" CHECK ("leader_id_event_registrations"."official_moderation" IS NULL OR "leader_id_event_registrations"."official_moderation" IN ('wait', 'approved', 'declined')),
	CONSTRAINT "leader_id_event_registrations_attempt_check" CHECK ("leader_id_event_registrations"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "leader_id_reward_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"reason" text DEFAULT 'LEADER_ID_CATALYST_SUBSCRIPTION' NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"qualifying_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_id_reward_grants_reason_check" CHECK ("leader_id_reward_grants"."reason" = 'LEADER_ID_CATALYST_SUBSCRIPTION'),
	CONSTRAINT "leader_id_reward_grants_amount_positive_check" CHECK ("leader_id_reward_grants"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "leader_id_event_id" bigint;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "leader_id_registration_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "leader_id_required_for_subscription" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "leader_id_registration_open" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "leader_id_sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "leader_id_requires_questionnaire" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "point_programs" ADD COLUMN "leader_id_subscription_reward" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leader_id_bindings" ADD CONSTRAINT "leader_id_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_id_event_registrations" ADD CONSTRAINT "leader_id_event_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_id_event_registrations" ADD CONSTRAINT "leader_id_event_registrations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_id_reward_grants" ADD CONSTRAINT "leader_id_reward_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_id_reward_grants" ADD CONSTRAINT "leader_id_reward_grants_program_id_point_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."point_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_id_reward_grants" ADD CONSTRAINT "leader_id_reward_grants_season_id_point_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."point_seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leader_id_reward_grants" ADD CONSTRAINT "leader_id_reward_grants_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leader_id_bindings_external_user_uq" ON "leader_id_bindings" USING btree ("leader_id_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leader_id_event_registrations_user_event_uq" ON "leader_id_event_registrations" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE INDEX "leader_id_event_registrations_user_status_idx" ON "leader_id_event_registrations" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "leader_id_reward_grants_user_reason_uq" ON "leader_id_reward_grants" USING btree ("user_id","reason");--> statement-breakpoint
CREATE UNIQUE INDEX "leader_id_reward_grants_transaction_uq" ON "leader_id_reward_grants" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "leader_id_reward_grants_program_season_idx" ON "leader_id_reward_grants" USING btree ("program_id","season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_leader_id_event_uq" ON "events" USING btree ("leader_id_event_id") WHERE "events"."leader_id_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_leader_id_active_order_idx" ON "events" USING btree ("leader_id_registration_active","leader_id_sort_order");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_leader_id_external_check" CHECK ("events"."leader_id_event_id" IS NULL OR ("events"."leader_id_event_id" > 0 AND "events"."leader_id_event_id" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_leader_id_active_requires_id_check" CHECK ("events"."leader_id_registration_active" = false OR "events"."leader_id_event_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "point_programs" ADD CONSTRAINT "point_programs_leader_id_reward_nonnegative_check" CHECK ("point_programs"."leader_id_subscription_reward" >= 0);--> statement-breakpoint
INSERT INTO "events" (
	"id",
	"title",
	"slug",
	"short_code",
	"description",
	"description_format",
	"organizer",
	"starts_at",
	"ends_at",
	"timezone",
	"venue",
	"city",
	"format",
	"status",
	"tags",
	"search_text",
	"accept_uploads_from",
	"accept_uploads_until",
	"direct_access_enabled",
	"leader_id_event_id",
	"leader_id_registration_active",
	"leader_id_required_for_subscription",
	"leader_id_registration_open",
	"leader_id_sort_order",
	"leader_id_requires_questionnaire"
)
SELECT
	gen_random_uuid(),
	'Официальное открытие акселерационной программы Catalyst',
	'leader-id-606466',
	'LID_606466',
	'Презентация партнёров и заказных задач программы Catalyst.',
	'text',
	'Catalyst',
	'2026-09-04 09:20:00+00'::timestamptz,
	'2026-09-04 10:05:00+00'::timestamptz,
	'Asia/Krasnoyarsk',
	'Точка кипения — Красноярск',
	'Красноярск',
	'offline',
	'published',
	ARRAY['Catalyst', 'Leader-ID']::text[],
	'официальное открытие акселерационной программы catalyst презентация партнёров заказных задач leader-id красноярск',
	'2026-08-28 00:00:00+00'::timestamptz,
	'2026-09-04 10:05:00+00'::timestamptz,
	true,
	606466,
	true,
	true,
	true,
	0,
	false
WHERE NOT EXISTS (
	SELECT 1 FROM "events" WHERE "leader_id_event_id" = 606466
);
