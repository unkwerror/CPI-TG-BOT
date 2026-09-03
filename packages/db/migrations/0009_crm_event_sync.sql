ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "managed_by_crm" boolean NOT NULL DEFAULT false;
