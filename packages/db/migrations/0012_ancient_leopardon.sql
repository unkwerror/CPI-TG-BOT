ALTER TABLE "submissions" ADD COLUMN "source_kind" text DEFAULT 'submission' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "crm_task_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_crm_task_uidx" ON "submissions" USING btree ("crm_task_id") WHERE "submissions"."crm_task_id" is not null;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_source_kind_check" CHECK ("submissions"."source_kind" in ('submission', 'event_request'));--> statement-breakpoint
INSERT INTO "submissions" (
	"id", "event_id", "user_id", "title", "text", "source_kind", "status",
	"idempotency_key", "created_at", "updated_at", "submitted_at"
)
SELECT request."id", request."event_id", request."user_id",
	'Вопрос по мероприятию: ' || event."title", request."text", 'event_request',
	'ready', 'event-request:' || request."id"::text,
	request."created_at", request."updated_at", request."created_at"
FROM "event_requests" request
JOIN "events" event ON event."id" = request."event_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "event_participants" participant
SET "last_submission_at" = CASE
	WHEN participant."last_submission_at" IS NULL OR participant."last_submission_at" < request."created_at"
		THEN request."created_at"
	ELSE participant."last_submission_at"
END
FROM "event_requests" request
WHERE participant."event_id" = request."event_id"
	AND participant."user_id" = request."user_id";--> statement-breakpoint
INSERT INTO "outbox_events" ("type", "aggregate_type", "aggregate_id", "payload")
SELECT 'crm.submission.sync', 'submission', request."id"::text,
	jsonb_build_object('submissionId', request."id"::text)
FROM "event_requests" request
JOIN "submissions" submission ON submission."id" = request."id"
WHERE submission."crm_synced_at" IS NULL
ON CONFLICT ("type", "aggregate_type", "aggregate_id") DO NOTHING;
