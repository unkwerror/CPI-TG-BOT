ALTER TABLE "artifacts"
ADD COLUMN "storage_deleted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "artifacts_storage_cleanup_idx"
ON "artifacts" USING btree ("status", "deleted_at", "storage_deleted_at");
