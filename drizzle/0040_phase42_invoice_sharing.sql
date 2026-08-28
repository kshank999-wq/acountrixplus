ALTER TABLE "invoices" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sent_to" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "send_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "first_viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_share_token_unique" UNIQUE("share_token");