CREATE TYPE "user_source" AS ENUM('bot', 'miniapp', 'import');
--> statement-breakpoint

ALTER TABLE "users"
  ADD COLUMN "crm_synced_at" timestamp with time zone,
  ADD COLUMN "crm_sync_error" text,
  ADD COLUMN "source" "user_source" DEFAULT 'miniapp' NOT NULL,
  ADD COLUMN "bot_started_at" timestamp with time zone,
  ADD COLUMN "bot_blocked_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX "users_created_idx" ON "users" USING btree ("created_at", "id");
--> statement-breakpoint

CREATE INDEX "users_bot_started_idx" ON "users" USING btree ("bot_started_at");
--> statement-breakpoint

-- Профиль в CRM уже есть у тех, кого туда отнесла синхронизация отправок.
UPDATE "users"
   SET "crm_synced_at" = "updated_at"
 WHERE "crm_person_id" IS NOT NULL
   AND "crm_synced_at" IS NULL;
--> statement-breakpoint

-- Существующие записи созданы только входом в Mini App, а войти в него можно
-- лишь через бота: чат с ботом у этих людей есть, дату первого /start мы не
-- сохраняли, поэтому берём дату появления записи.
UPDATE "users"
   SET "bot_started_at" = "created_at"
 WHERE "bot_started_at" IS NULL;
--> statement-breakpoint

-- Догоняем CRM теми, кто уже есть в базе: без карточки участника рассылка их не увидит.
INSERT INTO "outbox_events" ("type", "aggregate_type", "aggregate_id", "payload")
SELECT 'crm.user.sync', 'user', "user"."id"::text,
       jsonb_build_object('userId', "user"."id")
  FROM "users" AS "user"
 WHERE "user"."crm_person_id" IS NULL
ON CONFLICT ("type", "aggregate_type", "aggregate_id") DO NOTHING;
