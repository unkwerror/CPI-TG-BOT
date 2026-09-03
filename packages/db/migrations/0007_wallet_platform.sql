CREATE TYPE "point_season_status" AS ENUM ('draft', 'active', 'closed');
--> statement-breakpoint
CREATE TYPE "wallet_account_kind" AS ENUM ('user', 'system_issuance', 'system_redemption', 'store', 'event');
--> statement-breakpoint
CREATE TYPE "wallet_account_status" AS ENUM ('active', 'frozen', 'closed');
--> statement-breakpoint
CREATE TYPE "ledger_transaction_kind" AS ENUM ('welcome_grant', 'p2p_transfer', 'staff_credit', 'staff_debit', 'artifact_reward', 'store_purchase', 'admin_adjustment', 'season_opening', 'reversal');
--> statement-breakpoint
CREATE TYPE "event_form_status" AS ENUM ('draft', 'published', 'archived');
--> statement-breakpoint
CREATE TYPE "event_artifact_field_kind" AS ENUM ('text', 'checkbox', 'link', 'file', 'image', 'document', 'audio', 'video', 'archive');
--> statement-breakpoint
CREATE TYPE "reward_trigger" AS ENUM ('artifact_ready');
--> statement-breakpoint
CREATE TYPE "reward_claim_status" AS ENUM ('granted', 'reversed');
--> statement-breakpoint
CREATE TYPE "product_kind" AS ENUM ('physical', 'digital');
--> statement-breakpoint
CREATE TYPE "product_status" AS ENUM ('draft', 'published', 'paused', 'archived');
--> statement-breakpoint
CREATE TYPE "product_stock_mode" AS ENUM ('limited', 'unlimited');
--> statement-breakpoint
CREATE TYPE "inventory_movement_kind" AS ENUM ('restock', 'reserve', 'release', 'fulfill', 'adjustment');
--> statement-breakpoint
CREATE TYPE "store_order_status" AS ENUM ('paid', 'pickup_requested', 'ready_for_pickup', 'fulfilled');
--> statement-breakpoint
CREATE TYPE "qr_session_purpose" AS ENUM ('wallet', 'order_pickup');
--> statement-breakpoint
CREATE TYPE "qr_session_status" AS ENUM ('active', 'claimed', 'consumed', 'expired', 'cancelled');
--> statement-breakpoint
CREATE TYPE "wallet_intent_kind" AS ENUM ('p2p_transfer', 'staff_credit', 'staff_debit');
--> statement-breakpoint
CREATE TYPE "wallet_intent_status" AS ENUM ('created', 'awaiting_initiator_confirmation', 'awaiting_owner_confirmation', 'completed', 'rejected', 'cancelled', 'expired');
--> statement-breakpoint
CREATE TYPE "feed_post_kind" AS ENUM ('news', 'event', 'product', 'system');
--> statement-breakpoint
CREATE TYPE "feed_post_status" AS ENUM ('draft', 'published', 'archived');
--> statement-breakpoint
CREATE TYPE "feed_post_audience" AS ENUM ('all', 'participants', 'admins');
--> statement-breakpoint
CREATE TYPE "wallet_reset_status" AS ENUM ('draft', 'previewed', 'confirmed', 'executing', 'completed', 'failed', 'cancelled');
--> statement-breakpoint

ALTER TABLE "events" ADD COLUMN "active_form_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "form_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "form_field_id" uuid;
--> statement-breakpoint

CREATE TABLE "point_programs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "wallet_title" text NOT NULL DEFAULT 'Мои баллы',
  "unit_one" text NOT NULL DEFAULT 'балл',
  "unit_few" text NOT NULL DEFAULT 'балла',
  "unit_many" text NOT NULL DEFAULT 'баллов',
  "symbol" text,
  "icon_url" text,
  "welcome_amount" bigint NOT NULL DEFAULT 100,
  "max_transaction_amount" bigint NOT NULL DEFAULT 100000,
  "qr_ttl_seconds" integer NOT NULL DEFAULT 120,
  "intent_ttl_seconds" integer NOT NULL DEFAULT 90,
  "p2p_enabled" boolean NOT NULL DEFAULT true,
  "store_enabled" boolean NOT NULL DEFAULT true,
  "is_default" boolean NOT NULL DEFAULT false,
  "active_season_id" uuid,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "point_programs_code_unique" UNIQUE ("code"),
  CONSTRAINT "point_programs_welcome_nonnegative_check" CHECK ("welcome_amount" >= 0),
  CONSTRAINT "point_programs_max_transaction_check" CHECK ("max_transaction_amount" > 0 AND "max_transaction_amount" <= 1000000000),
  CONSTRAINT "point_programs_qr_ttl_check" CHECK ("qr_ttl_seconds" BETWEEN 15 AND 600),
  CONSTRAINT "point_programs_intent_ttl_check" CHECK ("intent_ttl_seconds" BETWEEN 15 AND 900)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "point_programs_default_uidx" ON "point_programs" ("is_default") WHERE "is_default" = true;
--> statement-breakpoint

CREATE TABLE "point_seasons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "code" text NOT NULL,
  "title" text NOT NULL,
  "status" "point_season_status" NOT NULL DEFAULT 'draft',
  "opening_amount" bigint NOT NULL DEFAULT 0,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "point_seasons_program_code_uq" UNIQUE ("program_id", "code"),
  CONSTRAINT "point_seasons_opening_nonnegative_check" CHECK ("opening_amount" >= 0),
  CONSTRAINT "point_seasons_dates_check" CHECK ("ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" >= "starts_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "point_seasons_active_uidx" ON "point_seasons" ("program_id") WHERE "status" = 'active';
--> statement-breakpoint
ALTER TABLE "point_programs"
  ADD CONSTRAINT "point_programs_active_season_id_point_seasons_id_fk"
  FOREIGN KEY ("active_season_id") REFERENCES "point_seasons"("id") ON DELETE RESTRICT;
--> statement-breakpoint

CREATE TABLE "wallet_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "season_id" uuid NOT NULL REFERENCES "point_seasons"("id") ON DELETE RESTRICT,
  "owner_kind" "wallet_account_kind" NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  "event_id" uuid REFERENCES "events"("id") ON DELETE RESTRICT,
  "system_key" text,
  "title" text NOT NULL,
  "balance" bigint NOT NULL DEFAULT 0,
  "allow_negative" boolean NOT NULL DEFAULT false,
  "status" "wallet_account_status" NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_accounts_owner_check" CHECK ((
    "owner_kind" = 'user' AND "user_id" IS NOT NULL AND "system_key" IS NULL
    AND "event_id" IS NULL AND "allow_negative" = false
  ) OR (
    "owner_kind" = 'event' AND "user_id" IS NULL AND "system_key" IS NOT NULL
    AND "event_id" IS NOT NULL
  ) OR (
    "owner_kind" NOT IN ('user', 'event') AND "user_id" IS NULL
    AND "system_key" IS NOT NULL AND "event_id" IS NULL
  )),
  CONSTRAINT "wallet_accounts_balance_check" CHECK ("allow_negative" = true OR "balance" >= 0),
  CONSTRAINT "wallet_accounts_version_check" CHECK ("version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_user_uidx" ON "wallet_accounts" ("program_id", "season_id", "user_id") WHERE "owner_kind" = 'user' AND "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_system_uidx" ON "wallet_accounts" ("program_id", "season_id", "system_key") WHERE "system_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_event_uidx" ON "wallet_accounts" ("program_id", "season_id", "event_id") WHERE "owner_kind" = 'event' AND "event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "wallet_accounts_user_idx" ON "wallet_accounts" ("user_id", "season_id");
--> statement-breakpoint

CREATE TABLE "ledger_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "season_id" uuid NOT NULL REFERENCES "point_seasons"("id") ON DELETE RESTRICT,
  "kind" "ledger_transaction_kind" NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "subject_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "event_id" uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "submission_id" uuid REFERENCES "submissions"("id") ON DELETE SET NULL,
  "related_order_id" uuid,
  "reversal_of_transaction_id" uuid,
  "reason" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sealed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_transactions_idempotency_uq" UNIQUE ("program_id", "idempotency_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_reversal_uidx" ON "ledger_transactions" ("reversal_of_transaction_id") WHERE "reversal_of_transaction_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ledger_transactions_season_created_idx" ON "ledger_transactions" ("season_id", "created_at");
--> statement-breakpoint
CREATE INDEX "ledger_transactions_subject_created_idx" ON "ledger_transactions" ("subject_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "ledger_transactions_event_created_idx" ON "ledger_transactions" ("event_id", "created_at");
--> statement-breakpoint
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_reversal_of_transaction_id_ledger_transactions_id_fk"
  FOREIGN KEY ("reversal_of_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT;
--> statement-breakpoint

CREATE TABLE "ledger_entries" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "transaction_id" uuid NOT NULL REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "account_id" uuid NOT NULL REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT,
  "delta" bigint NOT NULL,
  "balance_after" bigint NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_entries_transaction_account_uq" UNIQUE ("transaction_id", "account_id"),
  CONSTRAINT "ledger_entries_delta_nonzero_check" CHECK ("delta" <> 0)
);
--> statement-breakpoint
CREATE INDEX "ledger_entries_account_history_idx" ON "ledger_entries" ("account_id", "id");
--> statement-breakpoint

CREATE TABLE "event_form_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "status" "event_form_status" NOT NULL DEFAULT 'draft',
  "title" text NOT NULL,
  "instructions" text,
  "submit_button_label" text NOT NULL DEFAULT 'Отправить',
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "event_form_versions_event_version_uq" UNIQUE ("event_id", "version"),
  CONSTRAINT "event_form_versions_version_positive_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_form_versions_published_uidx" ON "event_form_versions" ("event_id") WHERE "status" = 'published';
--> statement-breakpoint

CREATE TABLE "event_artifact_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "form_version_id" uuid NOT NULL REFERENCES "event_form_versions"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "kind" "event_artifact_field_kind" NOT NULL,
  "label" text NOT NULL,
  "description" text,
  "required" boolean NOT NULL DEFAULT false,
  "min_items" integer NOT NULL DEFAULT 0,
  "max_items" integer NOT NULL DEFAULT 1,
  "allowed_mime_types" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "allowed_extensions" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "max_file_size_bytes" bigint,
  "sort_order" integer NOT NULL DEFAULT 0,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "event_artifact_fields_form_code_uq" UNIQUE ("form_version_id", "code"),
  CONSTRAINT "event_artifact_fields_min_check" CHECK ("min_items" >= 0),
  CONSTRAINT "event_artifact_fields_max_check" CHECK ("max_items" >= 1 AND "max_items" >= "min_items"),
  CONSTRAINT "event_artifact_fields_size_check" CHECK ("max_file_size_bytes" IS NULL OR "max_file_size_bytes" > 0)
);
--> statement-breakpoint
CREATE INDEX "event_artifact_fields_form_order_idx" ON "event_artifact_fields" ("form_version_id", "sort_order");
--> statement-breakpoint

CREATE TABLE "submission_field_values" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "submission_id" uuid NOT NULL REFERENCES "submissions"("id") ON DELETE CASCADE,
  "field_id" uuid NOT NULL REFERENCES "event_artifact_fields"("id") ON DELETE RESTRICT,
  "text_value" text,
  "json_value" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "submission_field_values_submission_field_uq" UNIQUE ("submission_id", "field_id"),
  CONSTRAINT "submission_field_values_value_check" CHECK ("text_value" IS NOT NULL OR "json_value" IS NOT NULL)
);
--> statement-breakpoint

ALTER TABLE "events"
  ADD CONSTRAINT "events_active_form_version_id_event_form_versions_id_fk"
  FOREIGN KEY ("active_form_version_id") REFERENCES "event_form_versions"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "submissions"
  ADD CONSTRAINT "submissions_form_version_id_event_form_versions_id_fk"
  FOREIGN KEY ("form_version_id") REFERENCES "event_form_versions"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "artifacts"
  ADD CONSTRAINT "artifacts_form_field_id_event_artifact_fields_id_fk"
  FOREIGN KEY ("form_field_id") REFERENCES "event_artifact_fields"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE TABLE "event_reward_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "trigger" "reward_trigger" NOT NULL DEFAULT 'artifact_ready',
  "amount" bigint NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "requires_manual_approval" boolean NOT NULL DEFAULT false,
  "valid_from" timestamp with time zone,
  "valid_until" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "event_reward_policies_event_uq" UNIQUE ("event_id"),
  CONSTRAINT "event_reward_policies_amount_positive_check" CHECK ("amount" > 0),
  CONSTRAINT "event_reward_policies_dates_check" CHECK ("valid_until" IS NULL OR "valid_from" IS NULL OR "valid_until" >= "valid_from")
);
--> statement-breakpoint

CREATE TABLE "event_reward_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "policy_id" uuid NOT NULL REFERENCES "event_reward_policies"("id") ON DELETE RESTRICT,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "submission_id" uuid NOT NULL REFERENCES "submissions"("id") ON DELETE RESTRICT,
  "transaction_id" uuid NOT NULL REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "status" "reward_claim_status" NOT NULL DEFAULT 'granted',
  "reversed_by_transaction_id" uuid REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "amount_snapshot" bigint NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reversed_at" timestamp with time zone,
  CONSTRAINT "event_reward_claims_event_user_uq" UNIQUE ("event_id", "user_id"),
  CONSTRAINT "event_reward_claims_transaction_uq" UNIQUE ("transaction_id"),
  CONSTRAINT "event_reward_claims_amount_positive_check" CHECK ("amount_snapshot" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_reward_claims_reversal_uidx" ON "event_reward_claims" ("reversed_by_transaction_id") WHERE "reversed_by_transaction_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "event_reward_claims_user_created_idx" ON "event_reward_claims" ("user_id", "created_at");
--> statement-breakpoint

CREATE TABLE "store_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "active" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  CONSTRAINT "store_categories_slug_unique" UNIQUE ("slug")
);
--> statement-breakpoint
CREATE INDEX "store_categories_active_order_idx" ON "store_categories" ("active", "sort_order");
--> statement-breakpoint

CREATE TABLE "store_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category_id" uuid REFERENCES "store_categories"("id") ON DELETE SET NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "kind" "product_kind" NOT NULL DEFAULT 'physical',
  "status" "product_status" NOT NULL DEFAULT 'draft',
  "price" bigint NOT NULL,
  "stock_mode" "product_stock_mode" NOT NULL DEFAULT 'limited',
  "per_user_limit" integer,
  "available_from" timestamp with time zone,
  "available_until" timestamp with time zone,
  "pickup_instructions" text,
  "cover_url" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  CONSTRAINT "store_products_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "store_products_price_positive_check" CHECK ("price" > 0),
  CONSTRAINT "store_products_limit_check" CHECK ("per_user_limit" IS NULL OR "per_user_limit" > 0),
  CONSTRAINT "store_products_dates_check" CHECK ("available_until" IS NULL OR "available_from" IS NULL OR "available_until" >= "available_from")
);
--> statement-breakpoint
CREATE INDEX "store_products_status_order_idx" ON "store_products" ("status", "sort_order");
--> statement-breakpoint
CREATE INDEX "store_products_category_idx" ON "store_products" ("category_id", "status");
--> statement-breakpoint

CREATE TABLE "store_product_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "store_products"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "object_key" text,
  "alt_text" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "store_product_media_product_order_idx" ON "store_product_media" ("product_id", "sort_order");
--> statement-breakpoint

CREATE TABLE "store_product_inventory" (
  "product_id" uuid PRIMARY KEY REFERENCES "store_products"("id") ON DELETE CASCADE,
  "on_hand" integer NOT NULL DEFAULT 0,
  "reserved" integer NOT NULL DEFAULT 0,
  "version" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "store_product_inventory_on_hand_check" CHECK ("on_hand" >= 0),
  CONSTRAINT "store_product_inventory_reserved_check" CHECK ("reserved" >= 0),
  CONSTRAINT "store_product_inventory_available_check" CHECK ("reserved" <= "on_hand"),
  CONSTRAINT "store_product_inventory_version_check" CHECK ("version" >= 0)
);
--> statement-breakpoint

CREATE TABLE "store_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "season_id" uuid NOT NULL REFERENCES "point_seasons"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "status" "store_order_status" NOT NULL DEFAULT 'paid',
  "total_points" bigint NOT NULL,
  "payment_transaction_id" uuid NOT NULL REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "idempotency_key" text NOT NULL,
  "request_hash" text,
  "pickup_instructions_snapshot" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ready_at" timestamp with time zone,
  "fulfilled_at" timestamp with time zone,
  "fulfilled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "store_orders_payment_transaction_id_unique" UNIQUE ("payment_transaction_id"),
  CONSTRAINT "store_orders_user_idempotency_uq" UNIQUE ("user_id", "idempotency_key"),
  CONSTRAINT "store_orders_total_positive_check" CHECK ("total_points" > 0)
);
--> statement-breakpoint
CREATE INDEX "store_orders_user_created_idx" ON "store_orders" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "store_orders_status_created_idx" ON "store_orders" ("status", "created_at");
--> statement-breakpoint

ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_related_order_id_store_orders_id_fk"
  FOREIGN KEY ("related_order_id") REFERENCES "store_orders"("id") ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE TABLE "store_order_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "store_orders"("id") ON DELETE RESTRICT,
  "product_id" uuid NOT NULL REFERENCES "store_products"("id") ON DELETE RESTRICT,
  "title_snapshot" text NOT NULL,
  "unit_price" bigint NOT NULL,
  "quantity" integer NOT NULL,
  "line_total" bigint NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "store_order_items_order_product_uq" UNIQUE ("order_id", "product_id"),
  CONSTRAINT "store_order_items_unit_price_check" CHECK ("unit_price" > 0),
  CONSTRAINT "store_order_items_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "store_order_items_line_total_check" CHECK ("line_total" = "unit_price" * "quantity")
);
--> statement-breakpoint

CREATE TABLE "inventory_movements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "store_products"("id") ON DELETE RESTRICT,
  "order_id" uuid REFERENCES "store_orders"("id") ON DELETE RESTRICT,
  "kind" "inventory_movement_kind" NOT NULL,
  "quantity" integer NOT NULL,
  "on_hand_after" integer NOT NULL,
  "reserved_after" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "reason" text,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_movements_idempotency_key_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "inventory_movements_quantity_nonzero_check" CHECK ("quantity" <> 0),
  CONSTRAINT "inventory_movements_balances_check" CHECK ("on_hand_after" >= 0 AND "reserved_after" >= 0 AND "reserved_after" <= "on_hand_after")
);
--> statement-breakpoint
CREATE INDEX "inventory_movements_product_created_idx" ON "inventory_movements" ("product_id", "created_at");
--> statement-breakpoint

CREATE TABLE "qr_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "season_id" uuid NOT NULL REFERENCES "point_seasons"("id") ON DELETE RESTRICT,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "purpose" "qr_session_purpose" NOT NULL DEFAULT 'wallet',
  "capabilities" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "token_hash" text NOT NULL,
  "status" "qr_session_status" NOT NULL DEFAULT 'active',
  "order_id" uuid REFERENCES "store_orders"("id") ON DELETE RESTRICT,
  "claimed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "claimed_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "qr_sessions_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "qr_sessions_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "qr_sessions_order_purpose_check" CHECK ("purpose" <> 'order_pickup' OR "order_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "qr_sessions_owner_status_idx" ON "qr_sessions" ("owner_user_id", "status", "expires_at");
--> statement-breakpoint
CREATE INDEX "qr_sessions_expiry_idx" ON "qr_sessions" ("status", "expires_at");
--> statement-breakpoint

CREATE TABLE "wallet_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "season_id" uuid NOT NULL REFERENCES "point_seasons"("id") ON DELETE RESTRICT,
  "qr_session_id" uuid NOT NULL REFERENCES "qr_sessions"("id") ON DELETE RESTRICT,
  "kind" "wallet_intent_kind" NOT NULL,
  "status" "wallet_intent_status" NOT NULL DEFAULT 'created',
  "initiator_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "payer_account_id" uuid NOT NULL REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT,
  "payee_account_id" uuid NOT NULL REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT,
  "required_confirmer_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  "amount" bigint NOT NULL,
  "reason" text,
  "event_id" uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "order_id" uuid REFERENCES "store_orders"("id") ON DELETE SET NULL,
  "transaction_id" uuid REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "idempotency_key" text NOT NULL,
  "request_hash" text,
  "expires_at" timestamp with time zone NOT NULL,
  "confirmed_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_intents_qr_session_id_unique" UNIQUE ("qr_session_id"),
  CONSTRAINT "wallet_intents_transaction_id_unique" UNIQUE ("transaction_id"),
  CONSTRAINT "wallet_intents_initiator_idempotency_uq" UNIQUE ("initiator_user_id", "idempotency_key"),
  CONSTRAINT "wallet_intents_amount_positive_check" CHECK ("amount" > 0),
  CONSTRAINT "wallet_intents_distinct_accounts_check" CHECK ("payer_account_id" <> "payee_account_id"),
  CONSTRAINT "wallet_intents_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX "wallet_intents_owner_status_idx" ON "wallet_intents" ("owner_user_id", "status", "expires_at");
--> statement-breakpoint
CREATE INDEX "wallet_intents_initiator_created_idx" ON "wallet_intents" ("initiator_user_id", "created_at");
--> statement-breakpoint

CREATE TABLE "feed_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "feed_post_kind" NOT NULL DEFAULT 'news',
  "status" "feed_post_status" NOT NULL DEFAULT 'draft',
  "audience" "feed_post_audience" NOT NULL DEFAULT 'all',
  "title" text NOT NULL,
  "summary" text,
  "body" text NOT NULL,
  "cover_url" text,
  "cta_label" text,
  "cta_url" text,
  "event_id" uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "product_id" uuid REFERENCES "store_products"("id") ON DELETE SET NULL,
  "pinned" boolean NOT NULL DEFAULT false,
  "published_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "feed_posts_status_published_idx" ON "feed_posts" ("status", "published_at");
--> statement-breakpoint

CREATE TABLE "point_fund_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "can_credit" boolean NOT NULL DEFAULT false,
  "can_debit" boolean NOT NULL DEFAULT false,
  "can_view" boolean NOT NULL DEFAULT true,
  "granted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "point_fund_access_program_user_uq" UNIQUE ("program_id", "user_id"),
  CONSTRAINT "point_fund_access_permission_check" CHECK ("can_credit" = true OR "can_debit" = true OR "can_view" = true)
);
--> statement-breakpoint

CREATE TABLE "wallet_reset_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "program_id" uuid NOT NULL REFERENCES "point_programs"("id") ON DELETE RESTRICT,
  "from_season_id" uuid NOT NULL REFERENCES "point_seasons"("id") ON DELETE RESTRICT,
  "to_season_id" uuid REFERENCES "point_seasons"("id") ON DELETE RESTRICT,
  "status" "wallet_reset_status" NOT NULL DEFAULT 'draft',
  "target_opening_amount" bigint NOT NULL DEFAULT 0,
  "affected_accounts" integer,
  "previous_total" bigint,
  "reason" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "confirmed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "previewed_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "wallet_reset_jobs_program_idempotency_uq" UNIQUE ("program_id", "idempotency_key"),
  CONSTRAINT "wallet_reset_jobs_target_nonnegative_check" CHECK ("target_opening_amount" >= 0),
  CONSTRAINT "wallet_reset_jobs_counts_check" CHECK ("affected_accounts" IS NULL OR "affected_accounts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "wallet_reset_jobs_program_created_idx" ON "wallet_reset_jobs" ("program_id", "created_at");
--> statement-breakpoint

-- Stable bootstrap identifiers make the migration retry/audit story explicit.
INSERT INTO "point_programs" (
  "id", "code", "wallet_title", "unit_one", "unit_few", "unit_many",
  "welcome_amount", "max_transaction_amount", "qr_ttl_seconds", "intent_ttl_seconds",
  "p2p_enabled", "store_enabled", "is_default"
) VALUES (
  '10000000-0000-4000-8000-000000000001', 'startup-studio', 'Мои баллы',
  'балл', 'балла', 'баллов', 100, 100000, 120, 90, true, true, true
);
--> statement-breakpoint

INSERT INTO "point_seasons" (
  "id", "program_id", "code", "title", "status", "opening_amount", "starts_at", "activated_at"
) VALUES (
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'initial', 'Первый сезон', 'active', 0, now(), now()
);
--> statement-breakpoint

UPDATE "point_programs"
SET "active_season_id" = '10000000-0000-4000-8000-000000000002', "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000001';
--> statement-breakpoint

INSERT INTO "wallet_accounts" (
  "id", "program_id", "season_id", "owner_kind", "system_key", "title",
  "balance", "allow_negative"
) VALUES
  ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'system_issuance', 'welcome', 'Стартовые начисления', 0, true),
  ('10000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'system_issuance', 'admin', 'Начисления сотрудников', 0, true),
  ('10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'system_redemption', 'redemption', 'Списания сотрудников', 0, false),
  ('10000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'store', 'store', 'Магазин', 0, false);
--> statement-breakpoint

INSERT INTO "wallet_accounts" (
  "program_id", "season_id", "owner_kind", "user_id", "title", "balance", "allow_negative"
)
SELECT
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'user',
  "user"."id",
  COALESCE(
    NULLIF(BTRIM("user"."full_name"), ''),
    CASE WHEN "user"."telegram_username" IS NOT NULL THEN '@' || "user"."telegram_username" END,
    "user"."telegram_user_id"::text
  ),
  100,
  false
FROM "users" "user";
--> statement-breakpoint

INSERT INTO "ledger_transactions" (
  "program_id", "season_id", "kind", "idempotency_key", "subject_user_id", "reason", "metadata"
)
SELECT
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'welcome_grant',
  'welcome:10000000-0000-4000-8000-000000000001:' || "user"."id"::text,
  "user"."id",
  'Стартовое начисление',
  '{"bootstrap":true}'::jsonb
FROM "users" "user";
--> statement-breakpoint

WITH ordered AS (
  SELECT
    ledger_tx."id" AS transaction_id,
    ROW_NUMBER() OVER (ORDER BY ledger_tx."subject_user_id") AS position
  FROM "ledger_transactions" ledger_tx
  WHERE ledger_tx."program_id" = '10000000-0000-4000-8000-000000000001'
    AND ledger_tx."kind" = 'welcome_grant'
    AND ledger_tx."idempotency_key" LIKE 'welcome:10000000-0000-4000-8000-000000000001:%'
)
INSERT INTO "ledger_entries" ("transaction_id", "account_id", "delta", "balance_after")
SELECT
  ordered.transaction_id,
  '10000000-0000-4000-8000-000000000003',
  -100,
  -100 * ordered.position
FROM ordered;
--> statement-breakpoint

INSERT INTO "ledger_entries" ("transaction_id", "account_id", "delta", "balance_after")
SELECT ledger_tx."id", account."id", 100, 100
FROM "ledger_transactions" ledger_tx
JOIN "wallet_accounts" account
  ON account."program_id" = ledger_tx."program_id"
 AND account."season_id" = ledger_tx."season_id"
 AND account."user_id" = ledger_tx."subject_user_id"
WHERE ledger_tx."program_id" = '10000000-0000-4000-8000-000000000001'
  AND ledger_tx."kind" = 'welcome_grant'
  AND ledger_tx."idempotency_key" LIKE 'welcome:10000000-0000-4000-8000-000000000001:%';
--> statement-breakpoint

UPDATE "wallet_accounts"
SET
  "balance" = -(SELECT COUNT(*)::bigint * 100 FROM "users"),
  "version" = "version" + 1,
  "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000003';
--> statement-breakpoint

UPDATE "ledger_transactions"
SET "sealed_at" = now()
WHERE "program_id" = '10000000-0000-4000-8000-000000000001'
  AND "kind" = 'welcome_grant'
  AND "idempotency_key" LIKE 'welcome:10000000-0000-4000-8000-000000000001:%';
--> statement-breakpoint

INSERT INTO "point_fund_access" (
  "program_id", "user_id", "can_credit", "can_debit", "can_view"
)
SELECT DISTINCT
  '10000000-0000-4000-8000-000000000001'::uuid,
  user_role."user_id",
  true,
  true,
  true
FROM "user_roles" user_role
JOIN "roles" role ON role."id" = user_role."role_id"
WHERE role."name" IN ('admin', 'superadmin')
ON CONFLICT ("program_id", "user_id") DO NOTHING;
--> statement-breakpoint

UPDATE "events"
SET "organizer" = 'Стартап-студия НГУ', "updated_at" = now()
WHERE "id" = 'da2cd805-a2c1-4a1a-95f4-2e362a187872'
  AND "organizer" IS DISTINCT FROM 'Стартап-студия НГУ';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_ledger_entry_before_seal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_sealed_at timestamp with time zone;
BEGIN
  SELECT ledger_tx."sealed_at"
    INTO parent_sealed_at
    FROM "ledger_transactions" ledger_tx
   WHERE ledger_tx."id" = NEW."transaction_id"
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger transaction % does not exist', NEW."transaction_id"
      USING ERRCODE = '23503';
  END IF;

  IF parent_sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ledger transaction % is sealed; post a reversal instead', NEW."transaction_id"
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_before_seal_trigger"
BEFORE INSERT ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "guard_ledger_entry_before_seal"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "assert_wallet_ledger_transaction_integrity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_transaction_id uuid;
  transaction_sealed_at timestamp with time zone;
  entry_count bigint;
  entry_sum numeric;
  mismatched_account_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    target_transaction_id := NEW."id";
  ELSE
    target_transaction_id := NEW."transaction_id";
  END IF;

  SELECT
    ledger_tx."sealed_at",
    COUNT(entry."id"),
    COALESCE(SUM(entry."delta"), 0),
    COUNT(entry."id") FILTER (
      WHERE account."id" IS NULL
         OR account."program_id" IS DISTINCT FROM ledger_tx."program_id"
         OR account."season_id" IS DISTINCT FROM ledger_tx."season_id"
    )
    INTO transaction_sealed_at, entry_count, entry_sum, mismatched_account_count
    FROM "ledger_transactions" ledger_tx
    LEFT JOIN "ledger_entries" entry ON entry."transaction_id" = ledger_tx."id"
    LEFT JOIN "wallet_accounts" account ON account."id" = entry."account_id"
   WHERE ledger_tx."id" = target_transaction_id
   GROUP BY ledger_tx."id", ledger_tx."program_id", ledger_tx."season_id", ledger_tx."sealed_at";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger transaction % does not exist', target_transaction_id
      USING ERRCODE = '23503';
  END IF;

  IF transaction_sealed_at IS NULL THEN
    RAISE EXCEPTION 'Ledger transaction % is not sealed', target_transaction_id
      USING ERRCODE = '23514';
  END IF;

  IF entry_count < 2 OR entry_sum <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is not balanced', target_transaction_id
      USING ERRCODE = '23514';
  END IF;

  IF mismatched_account_count > 0 THEN
    RAISE EXCEPTION 'Ledger transaction % contains an account from another program or season', target_transaction_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ledger_transactions_integrity_trigger"
AFTER INSERT ON "ledger_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_wallet_ledger_transaction_integrity"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "ledger_entries_integrity_trigger"
AFTER INSERT ON "ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_wallet_ledger_transaction_integrity"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_ledger_transaction_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."sealed_at" IS NULL
     AND NEW."sealed_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'sealed_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'sealed_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ledger_transactions rows are immutable except for the initial seal; post a reversal instead'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_transactions_immutable_trigger"
BEFORE UPDATE OR DELETE ON "ledger_transactions"
FOR EACH ROW EXECUTE FUNCTION "guard_ledger_transaction_mutation"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "prevent_wallet_ledger_entry_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries rows are immutable; post a reversal instead'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_immutable_trigger"
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "prevent_wallet_ledger_entry_mutation"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bootstrap_default_wallet_for_user"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_program_id uuid;
  selected_season_id uuid;
  selected_welcome_amount bigint;
  welcome_account_id uuid;
  user_account_id uuid;
  transaction_id uuid;
  welcome_balance_after bigint;
  user_balance_after bigint;
  welcome_key text;
BEGIN
  SELECT program."id", program."active_season_id", program."welcome_amount"
    INTO selected_program_id, selected_season_id, selected_welcome_amount
    FROM "point_programs" program
   WHERE program."is_default" = true
   FOR SHARE;

  IF selected_program_id IS NULL OR selected_season_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "wallet_accounts" (
    "program_id", "season_id", "owner_kind", "user_id", "title", "balance", "allow_negative"
  ) VALUES (
    selected_program_id,
    selected_season_id,
    'user',
    NEW.id,
    COALESCE(
      NULLIF(BTRIM(NEW.full_name), ''),
      CASE WHEN NEW.telegram_username IS NOT NULL THEN '@' || NEW.telegram_username END,
      NEW.telegram_user_id::text
    ),
    0,
    false
  )
  ON CONFLICT DO NOTHING
  RETURNING "id" INTO user_account_id;

  IF user_account_id IS NULL THEN
    SELECT account."id"
      INTO user_account_id
      FROM "wallet_accounts" account
     WHERE account."program_id" = selected_program_id
       AND account."season_id" = selected_season_id
       AND account."user_id" = NEW.id;
  END IF;

  IF selected_welcome_amount = 0 THEN
    RETURN NEW;
  END IF;

  welcome_key := 'welcome:' || selected_program_id::text || ':' || NEW.id::text;
  INSERT INTO "ledger_transactions" (
    "program_id", "season_id", "kind", "idempotency_key", "subject_user_id", "reason", "metadata"
  ) VALUES (
    selected_program_id,
    selected_season_id,
    'welcome_grant',
    welcome_key,
    NEW.id,
    'Стартовое начисление',
    '{"bootstrap":true}'::jsonb
  )
  ON CONFLICT ("program_id", "idempotency_key") DO NOTHING
  RETURNING "id" INTO transaction_id;

  IF transaction_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account."id"
    INTO welcome_account_id
    FROM "wallet_accounts" account
   WHERE account."program_id" = selected_program_id
     AND account."season_id" = selected_season_id
     AND account."system_key" = 'welcome'
   FOR UPDATE;

  IF welcome_account_id IS NULL THEN
    RAISE EXCEPTION 'Active point season has no WELCOME account'
      USING ERRCODE = '23514';
  END IF;

  UPDATE "wallet_accounts"
     SET "balance" = "balance" - selected_welcome_amount,
         "version" = "version" + 1,
         "updated_at" = now()
   WHERE "id" = welcome_account_id
  RETURNING "balance" INTO welcome_balance_after;

  UPDATE "wallet_accounts"
     SET "balance" = "balance" + selected_welcome_amount,
         "version" = "version" + 1,
         "updated_at" = now()
   WHERE "id" = user_account_id
  RETURNING "balance" INTO user_balance_after;

  INSERT INTO "ledger_entries" ("transaction_id", "account_id", "delta", "balance_after")
  VALUES
    (transaction_id, welcome_account_id, -selected_welcome_amount, welcome_balance_after),
    (transaction_id, user_account_id, selected_welcome_amount, user_balance_after);

  UPDATE "ledger_transactions"
     SET "sealed_at" = now()
   WHERE "id" = transaction_id;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "users_bootstrap_default_wallet_trigger"
AFTER INSERT ON "users"
FOR EACH ROW EXECUTE FUNCTION "bootstrap_default_wallet_for_user"();
