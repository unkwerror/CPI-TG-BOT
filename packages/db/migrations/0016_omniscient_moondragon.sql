ALTER TABLE "notification_deliveries" ADD COLUMN "messenger_provider" "messenger_provider";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "external_message_id" text;--> statement-breakpoint
UPDATE "notification_deliveries"
   SET "messenger_provider" = 'telegram'::"messenger_provider",
       "external_message_id" = "telegram_message_id"::text,
       "deduplication_key" = "deduplication_key" || ':telegram'
 WHERE "messenger_provider" IS NULL
   AND "deduplication_key" !~ ':(telegram|max)$';
