ALTER TABLE "users" ADD COLUMN "crm_person_id" uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX "users_crm_person_uidx"
  ON "users" USING btree ("crm_person_id")
  WHERE "crm_person_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "submissions"
  ADD COLUMN "crm_artifact_id" uuid,
  ADD COLUMN "crm_artifact_version_id" uuid,
  ADD COLUMN "crm_synced_at" timestamp with time zone;
--> statement-breakpoint

CREATE UNIQUE INDEX "submissions_crm_artifact_uidx"
  ON "submissions" USING btree ("crm_artifact_id")
  WHERE "crm_artifact_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "submissions_crm_version_uidx"
  ON "submissions" USING btree ("crm_artifact_version_id")
  WHERE "crm_artifact_version_id" IS NOT NULL;
--> statement-breakpoint

INSERT INTO "outbox_events" ("type", "aggregate_type", "aggregate_id", "payload")
SELECT 'crm.submission.sync', 'submission', submission.id::text,
       jsonb_build_object('submissionId', submission.id)
  FROM "submissions" submission
 WHERE submission.status = 'ready'
   AND submission.deleted_at IS NULL
ON CONFLICT ("type", "aggregate_type", "aggregate_id") DO NOTHING;
