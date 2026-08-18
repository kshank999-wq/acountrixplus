CREATE TABLE "integrity_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"check_key" text NOT NULL,
	"severity" text NOT NULL,
	"agrees" boolean NOT NULL,
	"left_cents" bigint DEFAULT 0 NOT NULL,
	"right_cents" bigint DEFAULT 0 NOT NULL,
	"difference_cents" bigint DEFAULT 0 NOT NULL,
	"detail" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrity_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"as_of" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"checks_run" integer DEFAULT 0 NOT NULL,
	"checks_skipped" integer DEFAULT 0 NOT NULL,
	"faults" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integrity_findings" ADD CONSTRAINT "integrity_findings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_findings" ADD CONSTRAINT "integrity_findings_run_id_integrity_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."integrity_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_runs" ADD CONSTRAINT "integrity_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integrity_findings_run_idx" ON "integrity_findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "integrity_findings_company_key_idx" ON "integrity_findings" USING btree ("company_id","check_key","created_at");--> statement-breakpoint
CREATE INDEX "integrity_runs_company_started_idx" ON "integrity_runs" USING btree ("company_id","started_at");