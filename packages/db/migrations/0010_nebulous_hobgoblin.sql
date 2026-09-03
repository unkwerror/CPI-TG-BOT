ALTER TABLE "feed_posts" ADD COLUMN "cover_bucket" text;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "cover_object_key" text;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "cover_content_type" text;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "cover_size_bytes" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_posts_cover_object_key_uq" ON "feed_posts" USING btree ("cover_object_key") WHERE "feed_posts"."cover_object_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_cover_storage_check" CHECK ((
        "feed_posts"."cover_bucket" IS NULL
        AND "feed_posts"."cover_object_key" IS NULL
        AND "feed_posts"."cover_content_type" IS NULL
        AND "feed_posts"."cover_size_bytes" IS NULL
      ) OR (
        "feed_posts"."cover_url" IS NULL
        AND "feed_posts"."cover_bucket" IS NOT NULL
        AND "feed_posts"."cover_object_key" IS NOT NULL
        AND "feed_posts"."cover_content_type" IS NOT NULL
        AND "feed_posts"."cover_size_bytes" > 0
      ));
