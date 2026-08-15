CREATE TYPE "public"."credit_party" AS ENUM('customer', 'vendor');--> statement-breakpoint
CREATE TABLE "deposit_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deposit_id" uuid NOT NULL,
	"payment_id" uuid,
	"chart_account_id" uuid,
	"amount_cents" bigint NOT NULL,
	"memo" text,
	CONSTRAINT "deposit_items_payment_unique" UNIQUE("payment_id"),
	CONSTRAINT "deposit_items_one_target" CHECK (("deposit_items"."payment_id" IS NULL) <> ("deposit_items"."chart_account_id" IS NULL)),
	CONSTRAINT "deposit_items_receipt_positive" CHECK ("deposit_items"."payment_id" IS NULL OR "deposit_items"."amount_cents" > 0),
	CONSTRAINT "deposit_items_non_zero" CHECK ("deposit_items"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"number" text NOT NULL,
	"deposit_date" date NOT NULL,
	"reference" text,
	"memo" text,
	"receipts_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposits_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "deposits_total_positive" CHECK ("deposits"."total_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "financial_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_applications" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "party" "credit_party" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "deposit_items" ADD CONSTRAINT "deposit_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_items" ADD CONSTRAINT "deposit_items_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_items" ADD CONSTRAINT "deposit_items_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_items" ADD CONSTRAINT "deposit_items_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_financial_account_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_items_deposit_idx" ON "deposit_items" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "deposits_company_date_idx" ON "deposits" USING btree ("company_id","deposit_date");--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_applications_bill_idx" ON "credit_applications" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "credit_notes_vendor_idx" ON "credit_notes" USING btree ("company_id","vendor_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_undeposited_is_receipt" CHECK ("payments"."financial_account_id" IS NOT NULL OR "payments"."kind" = 'receipt');--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_one_document" CHECK (("credit_applications"."invoice_id" IS NULL) <> ("credit_applications"."bill_id" IS NULL));--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_party_matches" CHECK (("credit_notes"."party" = 'customer' AND "credit_notes"."customer_id" IS NOT NULL AND "credit_notes"."vendor_id" IS NULL)
          OR ("credit_notes"."party" = 'vendor' AND "credit_notes"."vendor_id" IS NOT NULL AND "credit_notes"."customer_id" IS NULL));--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_document_matches" CHECK (("credit_notes"."party" = 'customer' AND "credit_notes"."bill_id" IS NULL)
          OR ("credit_notes"."party" = 'vendor' AND "credit_notes"."invoice_id" IS NULL));--> statement-breakpoint
-- Phase 12 data migration.
--
-- Cash-flow classification and cash-basis reporting both read `subtype` rather
-- than a column of their own (see `coa/classification.ts`), so companies
-- seeded before this phase need their existing accounts re-tagged or they land
-- in the wrong section of a statement they could not previously run.
UPDATE "chart_accounts" SET "subtype" = 'prepaid_expense'
  WHERE "number" = '1300' AND "subtype" = 'other_current_asset';--> statement-breakpoint
UPDATE "chart_accounts" SET "subtype" = 'unbilled_revenue'
  WHERE "number" IN ('1150', '1160') AND "subtype" = 'other_current_asset';--> statement-breakpoint
-- Accrued Liabilities is new in the standard chart. Installed for every
-- existing company that lacks it, because the alternative is that accrual
-- handling works for companies onboarded after this migration and silently
-- does nothing for the ones onboarded before.
INSERT INTO "chart_accounts" ("company_id", "number", "name", "type", "subtype", "description")
SELECT "c"."id", '2150', 'Accrued Liabilities', 'liability', 'accrued_liability',
       'Expenses incurred but not yet billed. Accrue at period end and reverse at the start of the next one.'
  FROM "companies" AS "c"
 WHERE NOT EXISTS (
   SELECT 1 FROM "chart_accounts" AS "a"
    WHERE "a"."company_id" = "c"."id" AND "a"."number" = '2150'
 );
