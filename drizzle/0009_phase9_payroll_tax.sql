CREATE TYPE "public"."pay_basis" AS ENUM('salary', 'hourly');--> statement-breakpoint
CREATE TYPE "public"."pay_frequency" AS ENUM('weekly', 'biweekly', 'semimonthly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."payroll_item_kind" AS ENUM('earning', 'employee_tax', 'employee_deduction', 'employer_tax', 'employer_contribution');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'posted', 'void');--> statement-breakpoint
CREATE TYPE "public"."worker_type" AS ENUM('employee', 'contractor');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'payroll';--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'remittance';--> statement-breakpoint
CREATE TABLE "document_tax_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_date" date NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"taxable_cents" bigint DEFAULT 0 NOT NULL,
	"exempt_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"rate_bp" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reference" text,
	"name" text NOT NULL,
	"email" text,
	"worker_type" "worker_type" DEFAULT 'employee' NOT NULL,
	"pay_basis" "pay_basis" DEFAULT 'salary' NOT NULL,
	"base_rate_cents" bigint DEFAULT 0 NOT NULL,
	"tax_id_last4" text,
	"start_date" date,
	"end_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"default_project_id" uuid,
	"default_cost_code_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_company_reference_unique" UNIQUE("company_id","reference"),
	CONSTRAINT "employees_tax_id_last4_length" CHECK ("employees"."tax_id_last4" IS NULL OR length("employees"."tax_id_last4") <= 4)
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"frequency" "pay_frequency" DEFAULT 'monthly' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_reference" text,
	"is_illustrative" boolean DEFAULT false NOT NULL,
	"gross_pay_cents" bigint DEFAULT 0 NOT NULL,
	"employee_withholding_cents" bigint DEFAULT 0 NOT NULL,
	"employee_deduction_cents" bigint DEFAULT 0 NOT NULL,
	"net_pay_cents" bigint DEFAULT 0 NOT NULL,
	"employer_tax_cents" bigint DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"memo" text,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_company_reference_unique" UNIQUE("company_id","reference"),
	CONSTRAINT "payroll_runs_period_order" CHECK ("payroll_runs"."period_end" >= "payroll_runs"."period_start")
);
--> statement-breakpoint
CREATE TABLE "payslip_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payslip_id" uuid NOT NULL,
	"kind" "payroll_item_kind" NOT NULL,
	"label" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"expense_account_id" uuid,
	"liability_account_id" uuid,
	"agency" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payslip_lines_non_negative" CHECK ("payslip_lines"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"hours_milli" bigint DEFAULT 0 NOT NULL,
	"gross_pay_cents" bigint DEFAULT 0 NOT NULL,
	"net_pay_cents" bigint DEFAULT 0 NOT NULL,
	"project_id" uuid,
	"cost_code_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payslips_run_employee_unique" UNIQUE("payroll_run_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"rate_bp" integer DEFAULT 0 NOT NULL,
	"is_exempt" boolean DEFAULT false NOT NULL,
	"liability_account_id" uuid,
	"effective_from" date,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_codes_company_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "tax_codes_rate_range" CHECK ("tax_codes"."rate_bp" >= 0 AND "tax_codes"."rate_bp" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "tax_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"jurisdiction" text,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"figures" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"filed_note" text,
	"filed_on" date,
	"prepared_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_filings_period_unique" UNIQUE("company_id","kind","jurisdiction","period_start","period_end")
);
--> statement-breakpoint
CREATE TABLE "tax_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"agency" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"paid_on" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"liability_account_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"reference" text,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_remittances_positive" CHECK ("tax_remittances"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "document_tax_lines" ADD CONSTRAINT "document_tax_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tax_lines" ADD CONSTRAINT "document_tax_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_default_project_id_projects_id_fk" FOREIGN KEY ("default_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_default_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("default_cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."payslips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_expense_account_id_chart_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_liability_account_id_chart_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_liability_account_id_chart_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_remittances" ADD CONSTRAINT "tax_remittances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_remittances" ADD CONSTRAINT "tax_remittances_liability_account_id_chart_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_remittances" ADD CONSTRAINT "tax_remittances_financial_account_id_financial_accounts_id_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_remittances" ADD CONSTRAINT "tax_remittances_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_remittances" ADD CONSTRAINT "tax_remittances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_tax_lines_document_idx" ON "document_tax_lines" USING btree ("document_type","document_id");--> statement-breakpoint
CREATE INDEX "document_tax_lines_period_idx" ON "document_tax_lines" USING btree ("company_id","document_date");--> statement-breakpoint
CREATE INDEX "employees_company_idx" ON "employees" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX "payroll_runs_period_idx" ON "payroll_runs" USING btree ("company_id","pay_date");--> statement-breakpoint
CREATE INDEX "payslip_lines_payslip_idx" ON "payslip_lines" USING btree ("payslip_id");--> statement-breakpoint
CREATE INDEX "payslips_run_idx" ON "payslips" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "payslips_employee_idx" ON "payslips" USING btree ("company_id","employee_id");--> statement-breakpoint
CREATE INDEX "tax_codes_company_idx" ON "tax_codes" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX "tax_filings_company_idx" ON "tax_filings" USING btree ("company_id","kind","period_end");--> statement-breakpoint
CREATE INDEX "tax_remittances_company_idx" ON "tax_remittances" USING btree ("company_id","paid_on");