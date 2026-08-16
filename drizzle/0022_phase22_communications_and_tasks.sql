CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."communication_channel" AS ENUM('email', 'call', 'meeting', 'note', 'letter', 'message');--> statement-breakpoint
CREATE TYPE "public"."communication_direction" AS ENUM('outbound', 'inbound', 'internal');--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"organization_id" uuid,
	"contact_id" uuid,
	"opportunity_id" uuid,
	"channel" "communication_channel" NOT NULL,
	"direction" "communication_direction" NOT NULL,
	"summary" text NOT NULL,
	"body" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transactional_message_id" uuid,
	"recorded_by" uuid,
	"actor_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communications_has_party" CHECK ("communications"."organization_id" IS NOT NULL OR "communications"."contact_id" IS NOT NULL OR "communications"."opportunity_id" IS NOT NULL),
	CONSTRAINT "communications_summary_not_empty" CHECK (length(btrim("communications"."summary")) > 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" "task_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_transactional_message_fk" FOREIGN KEY ("transactional_message_id") REFERENCES "public"."transactional_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communications_organization_idx" ON "communications" USING btree ("company_id","organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "communications_opportunity_idx" ON "communications" USING btree ("company_id","opportunity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "communications_contact_idx" ON "communications" USING btree ("contact_id","occurred_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("company_id","assigned_to","status","due_on");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_not_empty" CHECK (length(btrim("tasks"."title")) > 0);--> statement-breakpoint
-- Hand-written: bring existing rows into line before the constraint that will
-- reject them. Nothing in Phase 5 could produce either shape, but a constraint
-- added to a live table has to survive whatever is already in it, and failing
-- a migration at 3am over one stale row is not a good trade.
UPDATE "tasks" SET "completed_at" = now()
 WHERE "status" <> 'open' AND "completed_at" IS NULL;--> statement-breakpoint
UPDATE "tasks" SET "completed_at" = NULL
 WHERE "status" = 'open' AND "completed_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completion_shape" CHECK (("tasks"."status" = 'open') = ("tasks"."completed_at" IS NULL));