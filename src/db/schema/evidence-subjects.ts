import { pgTable, uuid, check, foreignKey, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies } from './tenancy'
import { evidenceSubjectEnum } from './evidence'
import { bankTransactions } from './banking'
import { journalEntries, reconciliations } from './ledger'
import { bills, customers, invoices, payments, vendors } from './receivables'
import { fixedAssets } from './assets'
import { payrollRuns } from './payroll'
import { billableExpenses } from './timebilling'
import { proposalVersions } from './crm'

/**
 * The exclusive arc for what may carry evidence (Phase 184, spec §13).
 *
 * ## The defect this exists to make impossible
 *
 * `document_links` and `record_notes` both held a `subject_type` enum and a
 * bare `subject_id`, and `modules/evidence/subjects.ts` argued the missing
 * foreign key was acceptable because the check lived in code:
 *
 * > It is the whole reason a missing foreign key is acceptable: the check that
 * > a constraint would do is done here, under the tenant filter, before
 * > anything is written.
 *
 * A foreign key is two guarantees and that sentence accounts for one. The other
 * is what happens when the referenced row is **deleted**, and nothing did it.
 *
 * `discardDraftEntry` deletes a draft journal entry; its comment reads *"Lines
 * cascade"*, which is true through a real foreign key and incomplete. The
 * working paper's link and the accountant's question survived the entry.
 * `openQuestions` — the company-wide work list — reads `record_notes` with no
 * join to the subject, so the orphaned question sat on somebody's list forever,
 * and typing an answer called `writeNote`, which called `requireSubject`, which
 * threw, inside the transaction that had just marked it resolved. The item could
 * be cleared **without** an answer and not **with** one.
 *
 * ## One table rather than twenty-four columns
 *
 * Phase 180's `asset_links` carries one nullable column per subject with a
 * CHECK that exactly one is set. Scaled directly to twelve kinds across two
 * consumers that is twenty-four columns and twenty-four foreign keys, and the
 * next consumer makes thirty-six.
 *
 * So the arc lives here once. `document_links` and `record_notes` each hold a
 * single composite foreign key to this table's key, `ON DELETE CASCADE`, and a
 * third consumer costs one more — which matters, because `subjects.ts` already
 * says attaching, detaching, reading and noting all go through one register.
 *
 * ## Why `subjectType` and `subjectId` are generated
 *
 * The obvious version holds the twelve columns *and* the pair the link tables
 * reference, and then there are two answers to one question. `GENERATED ALWAYS
 * AS … STORED` settles it: the twelve columns are the only place a subject's
 * identity lives and the pair is the database's own reading of them, so a row
 * cannot say `invoice` while holding a bill's id.
 *
 * The primary key then does one more thing for free. A generated column that
 * resolves to NULL cannot sit in a primary key, so a row with **no** kind set is
 * refused by the key rather than needing a CHECK of its own.
 *
 * ## A leaf file
 *
 * Its own module for the reason `asset-links.ts` is: it imports from seven
 * schema files that must not import it back, and it is exported last from
 * `index.ts`.
 */
export const evidenceSubjects = pgTable(
  'evidence_subjects',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /*
      One column per kind, in `EVIDENCE_SUBJECTS`' order so the register and the
      table read side by side. Every foreign key is `ON DELETE CASCADE`: that
      one word is the fix, written twelve times here rather than once in a
      function every future delete path would have to remember to call.
    */
    bankTransactionId: uuid('bank_transaction_id'),
    journalEntryId: uuid('journal_entry_id'),
    invoiceId: uuid('invoice_id'),
    billId: uuid('bill_id'),
    paymentId: uuid('payment_id'),
    fixedAssetId: uuid('fixed_asset_id'),
    reconciliationId: uuid('reconciliation_id'),
    payrollRunId: uuid('payroll_run_id'),
    expenseId: uuid('expense_id'),
    customerId: uuid('customer_id'),
    vendorId: uuid('vendor_id'),
    proposalVersionId: uuid('proposal_version_id'),

    subjectType: evidenceSubjectEnum('subject_type').generatedAlwaysAs(
      sql`CASE
      WHEN bank_transaction_id IS NOT NULL THEN 'bank_transaction'::evidence_subject
      WHEN journal_entry_id    IS NOT NULL THEN 'journal_entry'::evidence_subject
      WHEN invoice_id          IS NOT NULL THEN 'invoice'::evidence_subject
      WHEN bill_id             IS NOT NULL THEN 'bill'::evidence_subject
      WHEN payment_id          IS NOT NULL THEN 'payment'::evidence_subject
      WHEN fixed_asset_id      IS NOT NULL THEN 'fixed_asset'::evidence_subject
      WHEN reconciliation_id   IS NOT NULL THEN 'reconciliation'::evidence_subject
      WHEN payroll_run_id      IS NOT NULL THEN 'payroll_run'::evidence_subject
      WHEN expense_id          IS NOT NULL THEN 'expense'::evidence_subject
      WHEN customer_id         IS NOT NULL THEN 'customer'::evidence_subject
      WHEN vendor_id           IS NOT NULL THEN 'vendor'::evidence_subject
      WHEN proposal_version_id IS NOT NULL THEN 'proposal_version'::evidence_subject
    END`,
    ),

    subjectId: uuid('subject_id').generatedAlwaysAs(
      sql`coalesce(
      bank_transaction_id, journal_entry_id, invoice_id, bill_id, payment_id,
      fixed_asset_id, reconciliation_id, payroll_run_id, expense_id,
      customer_id, vendor_id, proposal_version_id
    )`,
    ),
  },
  (t) => ({
    pk: primaryKey({
      name: 'evidence_subjects_pkey',
      columns: [t.companyId, t.subjectType, t.subjectId],
    }),

    // Exactly one, counted rather than described: a row that is two kinds is a
    // row whose `subject_type` would be a coin toss.
    oneKind: check(
      'evidence_subjects_one_kind_check',
      sql`(${t.bankTransactionId} IS NOT NULL)::int
        + (${t.journalEntryId} IS NOT NULL)::int
        + (${t.invoiceId} IS NOT NULL)::int
        + (${t.billId} IS NOT NULL)::int
        + (${t.paymentId} IS NOT NULL)::int
        + (${t.fixedAssetId} IS NOT NULL)::int
        + (${t.reconciliationId} IS NOT NULL)::int
        + (${t.payrollRunId} IS NOT NULL)::int
        + (${t.expenseId} IS NOT NULL)::int
        + (${t.customerId} IS NOT NULL)::int
        + (${t.vendorId} IS NOT NULL)::int
        + (${t.proposalVersionId} IS NOT NULL)::int
        = 1`,
    ),

    bankTransactionFk: foreignKey({
      name: 'evidence_subjects_bank_transaction_fkey',
      columns: [t.companyId, t.bankTransactionId],
      foreignColumns: [bankTransactions.companyId, bankTransactions.id],
    }).onDelete('cascade'),
    journalEntryFk: foreignKey({
      name: 'evidence_subjects_journal_entry_fkey',
      columns: [t.companyId, t.journalEntryId],
      foreignColumns: [journalEntries.companyId, journalEntries.id],
    }).onDelete('cascade'),
    invoiceFk: foreignKey({
      name: 'evidence_subjects_invoice_fkey',
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [invoices.companyId, invoices.id],
    }).onDelete('cascade'),
    billFk: foreignKey({
      name: 'evidence_subjects_bill_fkey',
      columns: [t.companyId, t.billId],
      foreignColumns: [bills.companyId, bills.id],
    }).onDelete('cascade'),
    paymentFk: foreignKey({
      name: 'evidence_subjects_payment_fkey',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payments.companyId, payments.id],
    }).onDelete('cascade'),
    fixedAssetFk: foreignKey({
      name: 'evidence_subjects_fixed_asset_fkey',
      columns: [t.companyId, t.fixedAssetId],
      foreignColumns: [fixedAssets.companyId, fixedAssets.id],
    }).onDelete('cascade'),
    reconciliationFk: foreignKey({
      name: 'evidence_subjects_reconciliation_fkey',
      columns: [t.companyId, t.reconciliationId],
      foreignColumns: [reconciliations.companyId, reconciliations.id],
    }).onDelete('cascade'),
    payrollRunFk: foreignKey({
      name: 'evidence_subjects_payroll_run_fkey',
      columns: [t.companyId, t.payrollRunId],
      foreignColumns: [payrollRuns.companyId, payrollRuns.id],
    }).onDelete('cascade'),
    expenseFk: foreignKey({
      name: 'evidence_subjects_expense_fkey',
      columns: [t.companyId, t.expenseId],
      foreignColumns: [billableExpenses.companyId, billableExpenses.id],
    }).onDelete('cascade'),
    customerFk: foreignKey({
      name: 'evidence_subjects_customer_fkey',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }).onDelete('cascade'),
    vendorFk: foreignKey({
      name: 'evidence_subjects_vendor_fkey',
      columns: [t.companyId, t.vendorId],
      foreignColumns: [vendors.companyId, vendors.id],
    }).onDelete('cascade'),
    proposalVersionFk: foreignKey({
      name: 'evidence_subjects_proposal_version_fkey',
      columns: [t.companyId, t.proposalVersionId],
      foreignColumns: [proposalVersions.companyId, proposalVersions.id],
    }).onDelete('cascade'),
  }),
)
