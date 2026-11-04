import { and, eq, type SQL } from 'drizzle-orm'
import type { PgTable, PgColumn } from 'drizzle-orm/pg-core'
import { db, type Executor } from '@/db'
import {
  bankTransactions,
  billableExpenses,
  bills,
  customers,
  fixedAssets,
  invoices,
  journalEntries,
  payments,
  payrollRuns,
  proposalVersions,
  reconciliations,
  vendors,
} from '@/db/schema'
import { evidenceSubjects } from '@/db/schema'
import type { Permission } from '@/modules/permissions'
import { DomainError } from '@/modules/errors'

/**
 * What may carry evidence, and who may see it.
 *
 * ## Why a registry rather than a switch in each caller
 *
 * This register used to open by saying a polymorphic reference has no foreign
 * key, *"so the check has to live in code"*. Since Phase 184 it does not: the
 * twelve kinds are twelve columns on `evidence_subjects`, each with a composite
 * foreign key carrying the tenant, and `document_links` and `record_notes`
 * reference that table's key. A link to another company's record, to a record
 * that does not exist, or naming the wrong kind for a real id is refused by the
 * database.
 *
 * What the register is still for is the half a constraint cannot express:
 * **which permission guards each kind**. A read-only auditor may see the
 * receipt on a transaction and may not remove it; a bookkeeper has no business
 * near a payroll run, where the evidence is what people are paid. One
 * permission for the lot would have forced the wrong answer somewhere.
 *
 * So it says four things per kind: which table proves the record exists, which
 * permission a person needs to read its evidence, which to change it, and how
 * to name one in a list. Attaching, detaching, reading, and noting all go
 * through it. Adding a thirteenth kind means adding a row here, a value to the
 * enum, **and** a column with a foreign key to `evidence_subjects` — and a test
 * asserts the three lists against each other, so it cannot be added to one.
 *
 * ## Read and write are different permissions
 *
 * A read-only auditor may see the receipt on a transaction and may not remove
 * it. A bookkeeper may attach one to a bank transaction and has no business
 * touching a payroll run, where the evidence includes what people are paid.
 * One permission per kind would have forced the wrong answer somewhere.
 */

export type EvidenceSubject =
  | 'bank_transaction'
  | 'journal_entry'
  | 'invoice'
  | 'bill'
  | 'payment'
  | 'fixed_asset'
  | 'reconciliation'
  | 'payroll_run'
  | 'expense'
  | 'customer'
  | 'vendor'
  | 'proposal_version'

type SubjectDefinition = {
  /** What a person sees in a list: "Bill" rather than "bill". */
  label: string
  /** Seeing the record's evidence and notes. */
  view: Permission
  /** Attaching, detaching, and writing notes. */
  manage: Permission
  table: PgTable
  idColumn: PgColumn
  companyColumn: PgColumn
  /** How to name one in a list, when the id alone means nothing to anybody. */
  describe: PgColumn | null
}

const SUBJECTS: Record<EvidenceSubject, SubjectDefinition> = {
  bank_transaction: {
    label: 'Transaction',
    view: 'bookkeeping:view',
    manage: 'bookkeeping:categorize',
    table: bankTransactions,
    idColumn: bankTransactions.id,
    companyColumn: bankTransactions.companyId,
    describe: bankTransactions.description,
  },
  journal_entry: {
    label: 'Journal entry',
    view: 'accounting:view',
    // Evidence for an adjusting entry is the working paper behind it, so it
    // belongs to whoever may make the entry.
    manage: 'accounting:journal',
    table: journalEntries,
    idColumn: journalEntries.id,
    companyColumn: journalEntries.companyId,
    describe: journalEntries.memo,
  },
  invoice: {
    label: 'Invoice',
    view: 'accounting:view',
    manage: 'accounting:journal',
    table: invoices,
    idColumn: invoices.id,
    companyColumn: invoices.companyId,
    describe: invoices.number,
  },
  bill: {
    label: 'Bill',
    view: 'accounting:view',
    manage: 'accounting:journal',
    table: bills,
    idColumn: bills.id,
    companyColumn: bills.companyId,
    describe: bills.number,
  },
  payment: {
    label: 'Payment',
    view: 'accounting:view',
    manage: 'accounting:journal',
    table: payments,
    idColumn: payments.id,
    companyColumn: payments.companyId,
    describe: payments.reference,
  },
  fixed_asset: {
    label: 'Fixed asset',
    view: 'accounting:view',
    manage: 'accounting:journal',
    table: fixedAssets,
    idColumn: fixedAssets.id,
    companyColumn: fixedAssets.companyId,
    describe: fixedAssets.name,
  },
  reconciliation: {
    label: 'Reconciliation',
    view: 'reconciliation:view',
    // The bank statement itself. Attaching it is part of reconciling, so it
    // is the reconciler's permission rather than the accountant's.
    manage: 'reconciliation:perform',
    table: reconciliations,
    idColumn: reconciliations.id,
    companyColumn: reconciliations.companyId,
    describe: null,
  },
  payroll_run: {
    label: 'Payroll run',
    // Narrower on both sides than anything else here, because the evidence on
    // a payroll run is what individual people are paid.
    view: 'payroll:view',
    manage: 'payroll:manage',
    table: payrollRuns,
    idColumn: payrollRuns.id,
    companyColumn: payrollRuns.companyId,
    describe: null,
  },
  expense: {
    label: 'Expense',
    view: 'accounting:view',
    manage: 'accounting:journal',
    table: billableExpenses,
    idColumn: billableExpenses.id,
    companyColumn: billableExpenses.companyId,
    describe: billableExpenses.description,
  },
  customer: {
    label: 'Customer',
    view: 'crm:view',
    manage: 'crm:manage',
    table: customers,
    idColumn: customers.id,
    companyColumn: customers.companyId,
    describe: customers.name,
  },
  vendor: {
    label: 'Vendor',
    view: 'crm:view',
    manage: 'crm:manage',
    table: vendors,
    idColumn: vendors.id,
    companyColumn: vendors.companyId,
    describe: vendors.name,
  },
  proposal_version: {
    label: 'Sent proposal',
    view: 'proposals:view',
    // Attaching to a sent version is how the send path files the PDF it just
    // rendered. Nothing else should be adding to the record of what a client
    // received, which is why this is the send permission and not a general one.
    manage: 'proposals:manage',
    table: proposalVersions,
    idColumn: proposalVersions.id,
    companyColumn: proposalVersions.companyId,
    describe: null,
  },
}

export const EVIDENCE_SUBJECTS = Object.keys(SUBJECTS) as EvidenceSubject[]

export function subjectDefinition(subject: EvidenceSubject): SubjectDefinition {
  const definition = SUBJECTS[subject]
  if (!definition) throw new UnknownSubjectError(subject)
  return definition
}

export class UnknownSubjectError extends DomainError {
  readonly status = 400
  constructor(subject: string) {
    super(`Nothing can be attached to a "${subject}".`)
    this.name = 'UnknownSubjectError'
  }
}

export class NoSuchSubjectError extends DomainError {
  readonly status = 404
  constructor(subject: EvidenceSubject) {
    super(`That ${SUBJECTS[subject]?.label.toLowerCase() ?? 'record'} does not exist.`)
    this.name = 'NoSuchSubjectError'
  }
}

export type SubjectRef = { subjectType: EvidenceSubject; subjectId: string }

/**
 * Proves a record exists in the caller's company, and describes it.
 *
 * Kept after Phase 184, and its job changed. It used to be *"the whole reason a
 * missing foreign key is acceptable"*; the foreign key is there now, so what
 * this is for is the **sentence**. `evidence_subjects_journal_entry_fkey` is
 * what a person would otherwise be shown, and *"That journal entry does not
 * exist"* is what they should read (Phase 119). The constraint is what makes it
 * true; this is what makes it legible.
 *
 * It also still describes the record, which no constraint does.
 *
 * Throws rather than returning null, because every caller's response to "that
 * record is not yours" is identical and turning it into a return value is one
 * unchecked branch away from writing the link anyway.
 */
export async function requireSubject(
  companyId: string,
  ref: SubjectRef,
  exec: Executor = db,
): Promise<{ description: string | null }> {
  const definition = subjectDefinition(ref.subjectType)

  const [row] = await exec
    .select({
      // Selecting the id keeps the shape stable when there is nothing to
      // describe, which is true of a reconciliation and a payroll run.
      id: definition.idColumn,
      description: definition.describe ?? definition.idColumn,
    })
    .from(definition.table)
    .where(
      and(
        eq(definition.idColumn, ref.subjectId),
        eq(definition.companyColumn, companyId),
      ) as SQL,
    )
    .limit(1)

  if (!row) throw new NoSuchSubjectError(ref.subjectType)

  return {
    description: definition.describe ? (row.description as string | null) : null,
  }
}

/**
 * The column on `evidence_subjects` that holds each kind.
 *
 * Declared beside the register rather than derived from the kind's name,
 * because a derivation would be a rule with one exception waiting to happen —
 * `expense` is stored in `expense_id` and its table is `billable_expenses`, so
 * the names already disagree once.
 */
const SUBJECT_COLUMN: Record<EvidenceSubject, keyof typeof evidenceSubjects.$inferInsert> = {
  bank_transaction: 'bankTransactionId',
  journal_entry: 'journalEntryId',
  invoice: 'invoiceId',
  bill: 'billId',
  payment: 'paymentId',
  fixed_asset: 'fixedAssetId',
  reconciliation: 'reconciliationId',
  payroll_run: 'payrollRunId',
  expense: 'expenseId',
  customer: 'customerId',
  vendor: 'vendorId',
  proposal_version: 'proposalVersionId',
}

export function subjectColumnFor(subject: EvidenceSubject): string {
  const column = SUBJECT_COLUMN[subject]
  if (!column) throw new UnknownSubjectError(subject)
  return column
}

/**
 * Proves the record exists and makes sure it is referenceable (Phase 184).
 *
 * What every writer of a link or a note calls. Two steps, and they are
 * deliberately not one function's worth of cleverness:
 *
 * 1. `requireSubject`, for the sentence a person reads when the record is not
 *    theirs or not there.
 * 2. An upsert into `evidence_subjects`, which is what the link's foreign key
 *    points at.
 *
 * `onConflictDoNothing` rather than a read-then-write: a second attachment to
 * the same record is the common case, and the mobile outbox replays queued
 * actions, so two deliveries of one attach must leave one row — the claim
 * Phase 8 made about every replayed operation.
 *
 * Separate from `requireSubject` because the read paths call that one and must
 * not write. A single `requireSubject` that also inserted would have every
 * evidence *list* creating rows.
 */
export async function ensureSubject(
  companyId: string,
  ref: SubjectRef,
  exec: Executor = db,
): Promise<{ description: string | null }> {
  const found = await requireSubject(companyId, ref, exec)

  await exec
    .insert(evidenceSubjects)
    .values({ companyId, [subjectColumnFor(ref.subjectType)]: ref.subjectId })
    .onConflictDoNothing()

  return found
}
