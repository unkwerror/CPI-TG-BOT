ALTER TABLE "store_product_media" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "store_product_media" ADD COLUMN "bucket" text;--> statement-breakpoint
ALTER TABLE "store_product_media" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "store_product_media" ADD COLUMN "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "store_product_media" ADD COLUMN "upload_status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_product_media" ADD COLUMN "upload_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "store_product_media_product_status_order_idx" ON "store_product_media" USING btree ("product_id","upload_status","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "store_product_media_object_key_uq" ON "store_product_media" USING btree ("object_key") WHERE "store_product_media"."object_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "store_product_media" ADD CONSTRAINT "store_product_media_upload_status_check" CHECK ("store_product_media"."upload_status" IN ('pending', 'ready'));--> statement-breakpoint
ALTER TABLE "store_product_media" ADD CONSTRAINT "store_product_media_storage_check" CHECK ((
        "store_product_media"."upload_status" = 'pending'
        AND "store_product_media"."url" IS NULL
        AND "store_product_media"."bucket" IS NOT NULL
        AND "store_product_media"."object_key" IS NOT NULL
        AND "store_product_media"."content_type" IS NOT NULL
        AND "store_product_media"."size_bytes" > 0
        AND "store_product_media"."upload_expires_at" IS NOT NULL
      ) OR (
        "store_product_media"."upload_status" = 'ready'
        AND (
          "store_product_media"."url" IS NOT NULL
          OR (
            "store_product_media"."bucket" IS NOT NULL
            AND "store_product_media"."object_key" IS NOT NULL
            AND "store_product_media"."content_type" IS NOT NULL
            AND "store_product_media"."size_bytes" > 0
          )
        )
      ));