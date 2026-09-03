CREATE TABLE "custom_card_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_file_name" text NOT NULL,
	"source_bucket" text NOT NULL,
	"source_object_key" text NOT NULL,
	"source_size_bytes" bigint NOT NULL,
	"entry_path" text NOT NULL,
	"entry_html" text NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_uncompressed_bytes" bigint NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_card_packages_source_object_key_unique" UNIQUE("source_object_key"),
	CONSTRAINT "custom_card_packages_entity_type_check" CHECK ("custom_card_packages"."entity_type" IN ('event', 'product', 'feed_post')),
	CONSTRAINT "custom_card_packages_source_size_check" CHECK ("custom_card_packages"."source_size_bytes" > 0),
	CONSTRAINT "custom_card_packages_uncompressed_size_check" CHECK ("custom_card_packages"."total_uncompressed_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "description_format" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "card_html" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "card_package_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "card_html" text;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "card_package_id" uuid;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "card_html" text;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "card_package_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_card_packages" ADD CONSTRAINT "custom_card_packages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_card_packages_entity_idx" ON "custom_card_packages" USING btree ("entity_type","entity_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_card_package_id_custom_card_packages_id_fk" FOREIGN KEY ("card_package_id") REFERENCES "public"."custom_card_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_card_package_id_custom_card_packages_id_fk" FOREIGN KEY ("card_package_id") REFERENCES "public"."custom_card_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_card_package_id_custom_card_packages_id_fk" FOREIGN KEY ("card_package_id") REFERENCES "public"."custom_card_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_card_package_idx" ON "events" USING btree ("card_package_id");--> statement-breakpoint
CREATE INDEX "feed_posts_card_package_idx" ON "feed_posts" USING btree ("card_package_id");--> statement-breakpoint
CREATE INDEX "store_products_card_package_idx" ON "store_products" USING btree ("card_package_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_description_format_check" CHECK ("events"."description_format" IN ('text', 'html'));
