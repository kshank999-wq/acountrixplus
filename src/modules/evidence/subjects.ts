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
import type { Permission } from '@/modules/permissions'
import { DomainError } from '@/modules/errors'

/**
 * What may carry evidence, and who may see it.
 *
 * ## Why a registry rather than a switch in each caller
 *
 * A polymorphic reference has no foreign key, so nothing in the database stops
 * a link pointing at a uuid that belongs to another company — or to nothing at
 * all. The check has to live in code, and if it lives in the *caller* then
 * every new screen that attaches a file is a fresh chance to forget it.
 *
 * So there is one table, and it says three things per subject kind: which
 * table proves the record exists, which permission a person needs to read its
 * evidence, and which to change it. Attaching, detaching, reading, and noting
 * all go through it. Adding a twelfth kind is adding a row here — and the
 * enum in the schema will not compile without it, which is the point.
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
 * Every path that writes a link or a note calls this first. It is the whole
 * reason a missing foreign key is acceptable: the check that a constraint would
 * do is done here, under the tenant filter, before anything is written.
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
