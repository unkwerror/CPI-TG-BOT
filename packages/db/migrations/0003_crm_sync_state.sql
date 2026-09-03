ALTER TABLE "submissions"
  ADD COLUMN IF NOT EXISTS "crm_pending_review_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "crm_sync_error" text,
  ADD COLUMN IF NOT EXISTS "crm_sync_failed_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "submissions_crm_unsynced_idx"
  ON "submissions" USING btree ("user_id")
  WHERE "crm_synced_at" IS NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

INSERT INTO "outbox_events" ("type", "aggregate_type", "aggregate_id", "payload")
SELECT 'crm.submission.sync', 'submission', submission.id::text,
       jsonb_build_object('submissionId', submission.id)
  FROM "submissions" submission
 WHERE submission.status = 'ready'
   AND submission.deleted_at IS NULL
   AND submission.crm_synced_at IS NULL
ON CONFLICT ("type", "aggregate_type", "aggregate_id") DO UPDATE
  SET "processed_at" = NULL, "available_at" = now(), "attempts" = 0, "last_error" = NULL;
