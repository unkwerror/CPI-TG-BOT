ALTER TABLE "feed_posts" ADD COLUMN "body_format" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_products" ADD COLUMN "description_format" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_body_format_check" CHECK ("feed_posts"."body_format" IN ('text', 'html'));--> statement-breakpoint
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_description_format_check" CHECK ("store_products"."description_format" IN ('text', 'html'));
