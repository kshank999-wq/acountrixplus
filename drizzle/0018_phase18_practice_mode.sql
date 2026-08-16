CREATE TYPE "public"."engagement_initiator" AS ENUM('practice', 'client');--> statement-breakpoint
CREATE TYPE "public"."engagement_status" AS ENUM('pending', 'active', 'declined', 'ended');--> statement-breakpoint
CREATE TABLE "practice_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "engagement_status" DEFAULT 'pending' NOT NULL,
	"initiated_by" "engagement_initiator" NOT NULL,
	"granted_role" "role" DEFAULT 'accountant' NOT NULL,
	"note" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by" uuid,
	"responded_at" timestamp with time zone,
	"responded_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"ended_reason" text,
	CONSTRAINT "practice_engagements_responded" CHECK (("practice_engagements"."status" = 'pending') = ("practice_engagements"."responded_at" IS NULL)),
	CONSTRAINT "practice_engagements_ended" CHECK (("practice_engagements"."status" = 'ended') = ("practice_engagements"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "practice_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"practice_role" text DEFAULT 'staff' NOT NULL,
	"default_role" "role" DEFAULT 'accountant' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_members_unique" UNIQUE("practice_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "practices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"website" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "practice_engagement_id" uuid;--> statement-breakpoint
ALTER TABLE "practice_engagements" ADD CONSTRAINT "practice_engagements_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_engagements" ADD CONSTRAINT "practice_engagements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_engagements" ADD CONSTRAINT "practice_engagements_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_engagements" ADD CONSTRAINT "practice_engagements_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_engagements" ADD CONSTRAINT "practice_engagements_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_members" ADD CONSTRAINT "practice_members_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_members" ADD CONSTRAINT "practice_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practices" ADD CONSTRAINT "practices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practice_engagements_company_idx" ON "practice_engagements" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "practice_engagements_practice_idx" ON "practice_engagements" USING btree ("practice_id","status");--> statement-breakpoint
CREATE INDEX "practice_members_user_idx" ON "practice_members" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "practices_active_idx" ON "practices" USING btree ("is_active","name");--> statement-breakpoint
CREATE INDEX "memberships_engagement_idx" ON "memberships" USING btree ("practice_engagement_id");
--> statement-breakpoint
-- One live engagement per firm per company.
--
-- Written by hand because drizzle-kit cannot express a partial unique index,
-- and the constraint is worth more than the tidiness: without it, two clicks
-- on "invite" produce two engagements, accepting both produces two sets of
-- memberships, and ending one leaves the firm still holding the books.
--
-- Partial on purpose. A company must be able to re-engage a firm it once let
-- go, so `declined` and `ended` rows are outside the constraint.
CREATE UNIQUE INDEX "practice_engagements_live_unique"
  ON "practice_engagements" ("practice_id", "company_id")
  WHERE "status" IN ('pending', 'active');
