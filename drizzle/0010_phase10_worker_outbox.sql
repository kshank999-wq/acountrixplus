CREATE TYPE "public"."job_cadence" AS ENUM('hourly', 'daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."background_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."notification_topic" ADD VALUE 'remittance_due';--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" "background_job_status" DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	"schedule_id" uuid,
	"event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "background_jobs_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "background_jobs_attempts_sane" CHECK ("background_jobs"."attempts" >= 0),
	CONSTRAINT "background_jobs_max_attempts_sane" CHECK ("background_jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relayed_at" timestamp with time zone,
	"relay_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "job_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cadence" "job_cadence" NOT NULL,
	"hour_utc" integer DEFAULT 0 NOT NULL,
	"day_of_week" integer DEFAULT 1 NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_schedules_company_kind_unique" UNIQUE("company_id","kind"),
	CONSTRAINT "job_schedules_hour_range" CHECK ("job_schedules"."hour_utc" >= 0 AND "job_schedules"."hour_utc" <= 23),
	CONSTRAINT "job_schedules_dow_range" CHECK ("job_schedules"."day_of_week" >= 0 AND "job_schedules"."day_of_week" <= 6),
	CONSTRAINT "job_schedules_dom_range" CHECK ("job_schedules"."day_of_month" >= 1 AND "job_schedules"."day_of_month" <= 28)
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"jobs_processed" integer DEFAULT 0 NOT NULL,
	"hostname" text
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_schedules" ADD CONSTRAINT "job_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE INDEX "background_jobs_company_idx" ON "background_jobs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "background_jobs_kind_idx" ON "background_jobs" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "domain_events_pending_idx" ON "domain_events" USING btree ("occurred_at") WHERE "domain_events"."relayed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "domain_events_company_idx" ON "domain_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_entity_idx" ON "domain_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "job_schedules_due_idx" ON "job_schedules" USING btree ("is_active","next_run_at");