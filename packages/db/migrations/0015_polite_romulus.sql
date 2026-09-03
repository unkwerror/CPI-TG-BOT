CREATE TYPE "public"."messenger_provider" AS ENUM('telegram', 'max');--> statement-breakpoint
CREATE TABLE "user_messenger_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "messenger_provider" NOT NULL,
	"external_user_id" text NOT NULL,
	"chat_id" text,
	"username" text,
	"first_name" text,
	"last_name" text,
	"language_code" text,
	"avatar_url" text,
	"can_message" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_messenger_identities_external_numeric_check" CHECK ("user_messenger_identities"."external_user_id" ~ '^[0-9]+$'),
	CONSTRAINT "user_messenger_identities_chat_numeric_check" CHECK ("user_messenger_identities"."chat_id" is null or "user_messenger_identities"."chat_id" ~ '^-?[0-9]+$')
);
--> statement-breakpoint
INSERT INTO "user_messenger_identities" (
	"user_id",
	"provider",
	"external_user_id",
	"username",
	"first_name",
	"last_name",
	"language_code",
	"avatar_url",
	"created_at",
	"updated_at",
	"last_seen_at"
)
SELECT
	"id",
	'telegram'::"messenger_provider",
	"telegram_user_id"::text,
	"telegram_username",
	"telegram_first_name",
	"telegram_last_name",
	"telegram_language_code",
	"avatar_url",
	"created_at",
	"updated_at",
	"last_seen_at"
FROM "users"
WHERE "telegram_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "telegram_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_messenger_identities" ADD CONSTRAINT "user_messenger_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_messenger_identities_provider_external_uq" ON "user_messenger_identities" USING btree ("provider","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_messenger_identities_user_provider_uq" ON "user_messenger_identities" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "user_messenger_identities_user_idx" ON "user_messenger_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_messenger_identities_delivery_idx" ON "user_messenger_identities" USING btree ("provider","can_message");
