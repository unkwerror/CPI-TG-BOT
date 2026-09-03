-- Reconstructed from the deployed production schema. The production migration
-- journal already contains this timestamp, so this file mainly restores the
-- repository history and makes fresh installations converge on production.
ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "accepts_requests" boolean NOT NULL DEFAULT false;
