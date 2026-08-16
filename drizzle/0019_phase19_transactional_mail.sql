CREATE TYPE "public"."action_token_purpose" AS ENUM('password_reset', 'company_invitation', 'practice_invitation');--> statement-breakpoint
CREATE TYPE "public"."delivery_outcome" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "action_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "action_token_purpose" NOT NULL,
	"lookup_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"user_id" uuid,
	"company_id" uuid,
	"practice_id" uuid,
	"role" "role",
	"invited_name" text,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_ip" text,
	CONSTRAINT "action_tokens_purpose_shape" CHECK (("action_tokens"."purpose" = 'company_invitation') = ("action_tokens"."company_id" IS NOT NULL)
          AND ("action_tokens"."purpose" = 'practice_invitation') = ("action_tokens"."practice_id" IS NOT NULL)
          AND ("action_tokens"."purpose" <> 'password_reset' OR "action_tokens"."user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "transactional_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"kind" text NOT NULL,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"outcome" "delivery_outcome" NOT NULL,
	"provider_key" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_tokens" ADD CONSTRAINT "action_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_tokens" ADD CONSTRAINT "action_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_tokens" ADD CONSTRAINT "action_tokens_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_tokens" ADD CONSTRAINT "action_tokens_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_messages" ADD CONSTRAINT "transactional_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_tokens_prefix_idx" ON "action_tokens" USING btree ("lookup_prefix","purpose");--> statement-breakpoint
CREATE INDEX "action_tokens_email_idx" ON "action_tokens" USING btree ("email","purpose");--> statement-breakpoint
CREATE INDEX "action_tokens_company_idx" ON "action_tokens" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "action_tokens_practice_idx" ON "action_tokens" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "transactional_messages_email_idx" ON "transactional_messages" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "transactional_messages_company_idx" ON "transactional_messages" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "transactional_messages_failed_idx" ON "transactional_messages" USING btree ("outcome","created_at");