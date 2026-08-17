CREATE TYPE "public"."engagement_staffing" AS ENUM('whole_firm', 'assigned_only');--> statement-breakpoint
CREATE TABLE "engagement_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role",
	"note" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	CONSTRAINT "engagement_assignments_unique" UNIQUE("engagement_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "practice_engagements" ADD COLUMN "staffing" "engagement_staffing" DEFAULT 'whole_firm' NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement_assignments" ADD CONSTRAINT "engagement_assignments_engagement_id_practice_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."practice_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_assignments" ADD CONSTRAINT "engagement_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_assignments" ADD CONSTRAINT "engagement_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_assignments_user_idx" ON "engagement_assignments" USING btree ("user_id");