import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  bills,
  chartAccounts,
  customers,
  dataExports,
  invoices,
  journalEntries,
  journalLines,
  payments,
  bankTransactions,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'

/**
 * Exporting a company's data (spec §19: "users must be able to export their
 * accounting records and key business data").
 *
 * ## Why this requirement is not a nice-to-have
 *
 * It is the clause that makes the product leaveable. An accounting system
 * holding books that cannot be got out is one whose customers are trapped by
 * their own history rather than kept by the software being good, and spec §19
 * puts it beside encryption and audit for that reason.
 *
 * So the test this has to pass is not "does it produce a file" but **could an
 * accountant rebuild these books somewhere else from it**. That drives three
 * decisions:
 *
 * - **Journal lines carry their account number and name**, not just an id. An
 *   export whose foreign keys point at rows in another file is a database
 *   dump; one an accountant can read is a set of statements.
 * - **Money is exported in units, not cents.** Internally everything is
 *   integer cents (ADR 0002) and that is right; a file that opens in a
 *   spreadsheet showing 108000 for $1,080.00 is not.
 * - **CSV, with real quoting.** It is the format every other accounting
 *   package imports. JSON would be tidier and importable by nothing.
 *
 * ## What it is not
 *
 * Not a backup. It contains what a person needs to read and re-enter the
 * books, not the internal state needed to restore this system — no ids of
 * queue rows, no audit log, no session or security tables. See
 * `scripts/backup.sh` for the other thing.
 */

export type DatasetName =
  | 'chart_of_accounts'
  | 'journal'
  | 'bank_transactions'
  | 'customers'
  | 'invoices'
  | 'vendors'
  | 'bills'
  | 'payments'

export const DATASETS: DatasetName[] = [
  'chart_of_accounts',
  'journal',
  'bank_transactions',
  'customers',
  'invoices',
  'vendors',
  'bills',
  'payments',
]

export const DATASET_LABELS: Record<DatasetName, string> = {
  chart_of_accounts: 'Chart of accounts',
  journal: 'Journal entries and lines',
  bank_transactions: 'Bank transactions',
  customers: 'Customers',
  invoices: 'Invoices',
  vendors: 'Vendors',
  bills: 'Bills',
  payments: 'Payments',
}

export type ExportedFile = { name: string; content: string; rowCount: number }

/**
 * Renders one CSV file.
 *
 * The quoting rules are RFC 4180 and they are not optional: a customer called
 * `Smith, Jones & Co` or a memo containing a newline will silently shift every
 * following column if the fields are simply joined with commas. That failure
 * produces a file that looks fine and is wrong, which is the worst kind.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const text = value instanceof Date ? value.toISOString() : String(value)
    // A field needs quoting if it contains a comma, a quote, or a line break;
    // inside quotes, a quote is doubled.
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(','))
  }

  // A trailing newline, so appending or concatenating files does not join the
  // last row of one to the header of the next.
  return `${lines.join('\r\n')}\r\n`
}

/** Integer cents to a decimal string a spreadsheet reads as money. */
function units(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  const negative = cents < 0
  const absolute = Math.abs(cents)
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

export async function exportCompanyData(
  ctx: ActorContext,
  opts: { datasets?: DatasetName[] } = {},
): Promise<{ files: ExportedFile[]; rowCount: number; byteCount: number }> {
  // The broadest read in the system, so it takes the broadest permission.
  // Someone who cannot see the ledger in the UI cannot take it home in a file.
  requirePermission(ctx, 'reports:financial')

  const wanted = opts.datasets?.length ? opts.datasets : DATASETS
  const files: ExportedFile[] = []

  for (const dataset of wanted) {
    files.push(await buildDataset(ctx, dataset))
  }

  const rowCount = files.reduce((sum, file) => sum + file.rowCount, 0)
  const byteCount = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)

  await db.insert(dataExports).values({
    companyId: ctx.companyId,
    requestedBy: ctx.userId,
    datasets: wanted.join(','),
    rowCount,
    byteCount,
  })

  // Also in the audit log, because "who took a copy of everything" belongs
  // beside the other privileged actions rather than only in a table somebody
  // has to know to look at.
  await recordAudit(ctx, {
    action: 'data.export',
    entityType: 'company',
    entityId: ctx.companyId,
    after: { datasets: wanted, rowCount, byteCount },
  })

  return { files, rowCount, byteCount }
}

async function buildDataset(ctx: ActorContext, dataset: DatasetName): Promise<ExportedFile> {
  switch (dataset) {
    case 'chart_of_accounts': {
      const rows = await db
        .select({
          number: chartAccounts.number,
          name: chartAccounts.name,
          type: chartAccounts.type,
          subtype: chartAccounts.subtype,
          is_active: chartAccounts.isActive,
          description: chartAccounts.description,
        })
        .from(chartAccounts)
        .where(scoped(ctx, chartAccounts))
        .orderBy(asc(chartAccounts.number))

      return file('chart_of_accounts.csv', rows, [
        'number',
        'name',
        'type',
        'subtype',
        'is_active',
        'description',
      ])
    }

    case 'journal': {
      // One row per line, with the entry's header repeated. Denormalized
      // deliberately: a spreadsheet cannot join, and this is the file an
      // accountant filters and pivots.
      const rows = await db
        .select({
          entry_number: journalEntries.entryNumber,
          entry_date: journalEntries.entryDate,
          status: journalEntries.status,
          source: journalEntries.source,
          memo: journalEntries.memo,
          account_number: chartAccounts.number,
          account_name: chartAccounts.name,
          debit: journalLines.debitCents,
          credit: journalLines.creditCents,
          line_memo: journalLines.memo,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
        .where(eq(journalEntries.companyId, ctx.companyId))
        .orderBy(asc(journalEntries.entryNumber), asc(journalLines.sortOrder))

      return file(
        'journal.csv',
        rows.map((row) => ({ ...row, debit: units(row.debit), credit: units(row.credit) })),
        [
          'entry_number',
          'entry_date',
          'status',
          'source',
          'memo',
          'account_number',
          'account_name',
          'debit',
          'credit',
          'line_memo',
        ],
      )
    }

    case 'bank_transactions': {
      const rows = await db
        .select({
          posted_date: bankTransactions.postedDate,
          description: bankTransactions.description,
          merchant: bankTransactions.merchantName,
          amount: bankTransactions.amountCents,
          review_state: bankTransactions.reviewState,
          account_number: chartAccounts.number,
          account_name: chartAccounts.name,
        })
        .from(bankTransactions)
        .leftJoin(chartAccounts, eq(chartAccounts.id, bankTransactions.chartAccountId))
        .where(eq(bankTransactions.companyId, ctx.companyId))
        .orderBy(asc(bankTransactions.postedDate))

      return file(
        'bank_transactions.csv',
        rows.map((row) => ({ ...row, amount: units(row.amount) })),
        [
          'posted_date',
          'description',
          'merchant',
          'amount',
          'review_state',
          'account_number',
          'account_name',
        ],
      )
    }

    case 'customers': {
      const rows = await db
        .select({
          name: customers.name,
          email: customers.email,
          phone: customers.phone,
          created_at: customers.createdAt,
        })
        .from(customers)
        .where(scoped(ctx, customers))
        .orderBy(asc(customers.name))

      return file('customers.csv', rows, ['name', 'email', 'phone', 'created_at'])
    }

    case 'invoices': {
      const rows = await db
        .select({
          number: invoices.number,
          customer: customers.name,
          issue_date: invoices.issueDate,
          due_date: invoices.dueDate,
          status: invoices.status,
          subtotal: invoices.subtotalCents,
          tax: invoices.taxCents,
          total: invoices.totalCents,
          balance: invoices.balanceCents,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(eq(invoices.companyId, ctx.companyId))
        .orderBy(asc(invoices.issueDate))

      return file(
        'invoices.csv',
        rows.map((row) => ({
          ...row,
          subtotal: units(row.subtotal),
          tax: units(row.tax),
          total: units(row.total),
          balance: units(row.balance),
        })),
        ['number', 'customer', 'issue_date', 'due_date', 'status', 'subtotal', 'tax', 'total', 'balance'],
      )
    }

    case 'vendors': {
      const rows = await db
        .select({
          name: vendors.name,
          email: vendors.email,
          phone: vendors.phone,
          created_at: vendors.createdAt,
        })
        .from(vendors)
        .where(scoped(ctx, vendors))
        .orderBy(asc(vendors.name))

      return file('vendors.csv', rows, ['name', 'email', 'phone', 'created_at'])
    }

    case 'bills': {
      const rows = await db
        .select({
          number: bills.number,
          vendor: vendors.name,
          issue_date: bills.issueDate,
          due_date: bills.dueDate,
          status: bills.status,
          total: bills.totalCents,
          balance: bills.balanceCents,
        })
        .from(bills)
        .innerJoin(vendors, eq(vendors.id, bills.vendorId))
        .where(eq(bills.companyId, ctx.companyId))
        .orderBy(asc(bills.issueDate))

      return file(
        'bills.csv',
        rows.map((row) => ({
          ...row,
          total: units(row.total),
          balance: units(row.balance),
        })),
        ['number', 'vendor', 'issue_date', 'due_date', 'status', 'total', 'balance'],
      )
    }

    case 'payments': {
      const rows = await db
        .select({
          payment_date: payments.paymentDate,
          kind: payments.kind,
          amount: payments.amountCents,
          reference: payments.reference,
          memo: payments.memo,
        })
        .from(payments)
        .where(scoped(ctx, payments))
        .orderBy(asc(payments.paymentDate))

      return file(
        'payments.csv',
        rows.map((row) => ({ ...row, amount: units(row.amount) })),
        ['payment_date', 'kind', 'amount', 'reference', 'memo'],
      )
    }
  }
}

function file(
  name: string,
  rows: Array<Record<string, unknown>>,
  columns: string[],
): ExportedFile {
  return { name, content: toCsv(rows, columns), rowCount: rows.length }
}

/** Previous exports, so "who took a copy" is answerable from the UI. */
export async function listExports(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'reports:financial')

  return db
    .select()
    .from(dataExports)
    .where(scoped(ctx, dataExports))
    .orderBy(asc(dataExports.createdAt))
    .limit(opts.limit ?? 20)
}
