import { asc, desc, eq } from 'drizzle-orm'
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
import { functionalCurrency } from '@/modules/fx/service'
import { convert, describeRate } from '@/modules/fx/rates'
import {
  columnsFor,
  decimal,
  moneyColumns,
  spread,
  summarise,
  tally,
  type CurrencyTally,
  type Money,
} from './exported-money'

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

export type ExportedFile = {
  name: string
  content: string
  rowCount: number
  /**
   * What each currency in this file sums to, for the manifest. Empty for a
   * file with no money in it — which is not the same as a file whose money is
   * all in one currency, and the manifest says so differently.
   */
  currencies: CurrencyTally[]
}

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

/**
 * Money rendering lives in `exported-money.ts` (Phase 103).
 *
 * This module used to hold `units(cents: number): string`, which returned a
 * bare decimal. Every call site was one keystroke from omitting the currency
 * and none of them could be checked, because a bare number is a perfectly good
 * argument. `moneyColumns` cannot be called without saying what currency the
 * amount is in.
 */

export async function exportCompanyData(
  ctx: ActorContext,
  opts: { datasets?: DatasetName[] } = {},
): Promise<{ files: ExportedFile[]; rowCount: number; byteCount: number }> {
  // The broadest read in the system, so it takes the broadest permission.
  // Someone who cannot see the ledger in the UI cannot take it home in a file.
  requirePermission(ctx, 'reports:financial')

  const wanted = opts.datasets?.length ? opts.datasets : DATASETS
  const files: ExportedFile[] = []

  /*
    Read once and passed down. Every file needs it — the foreign ones to name
    what they were booked at, and the rest to say that their single currency is
    the company's own rather than leaving a bare column (Phase 103).
  */
  const home = await functionalCurrency(ctx.companyId)

  for (const dataset of wanted) {
    files.push(await buildDataset(ctx, dataset, home))
  }

  // Last, because it describes the others. Not counted in `rowCount`: it is a
  // description of the export rather than a part of the books.
  files.push(manifest(files))

  const rowCount = files
    .filter((file) => file.name !== MANIFEST)
    .reduce((sum, file) => sum + file.rowCount, 0)
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

export const MANIFEST = 'manifest.csv'

/** A rate of 1.000000, for a payment in the company's own currency. */
const MILLION = 1_000_000

/**
 * The file that says whether the others can be added up.
 *
 * "Can I sum this column" is a question about a whole file rather than about a
 * row, so the answer is a file rather than a column — and deliberately not a
 * totals row inside each CSV, because a totals row is a row every importer
 * reads as data. That is how a customer list acquires a customer called TOTAL.
 */
function manifest(files: ExportedFile[]): ExportedFile {
  const rows = files.flatMap((file) =>
    file.currencies.length === 0
      ? [{ file: file.name, currency: '', rows: String(file.rowCount), total: '', note: summarise(file.name, []) }]
      : file.currencies.map((entry) => ({
          file: file.name,
          currency: entry.currency,
          rows: String(entry.rowCount),
          total: decimal(entry.totalCents),
          note: summarise(file.name, file.currencies),
        })),
  )

  return {
    name: MANIFEST,
    content: toCsv(rows, ['file', 'currency', 'rows', 'total', 'note']),
    rowCount: rows.length,
    currencies: [],
  }
}

async function buildDataset(
  ctx: ActorContext,
  dataset: DatasetName,
  home: string,
): Promise<ExportedFile> {
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

      /*
        The ledger is functional-currency by definition, so one column names it
        for the whole file rather than four per amount. A euro invoice appears
        here at what it was booked at — which is why `invoices.csv` carries its
        functional columns too, so the two files can be tied together.
      */
      return file(
        'journal.csv',
        rows.map((row) => ({
          ...row,
          debit: decimal(row.debit),
          credit: decimal(row.credit),
          currency: home,
        })),
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
          'currency',
          'line_memo',
        ],
        // Debits and credits are equal and opposite over a balanced ledger, so
        // a signed total would be zero and tell nobody anything. The tally is
        // the debit side, which is what "how big are these books" means.
        rows.map((row) => ({ cents: row.debit ?? 0, currency: home })),
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

      /*
        Neither `bank_accounts` nor `bank_transactions` has a currency column,
        so every row here is in the company's own currency by construction.
        That is a fact worth stating rather than an answer worth inventing —
        and it means no money column in this export is bare.
      */
      return file(
        'bank_transactions.csv',
        rows.map((row) => ({ ...row, amount: decimal(row.amount), currency: home })),
        [
          'posted_date',
          'description',
          'merchant',
          'amount',
          'currency',
          'review_state',
          'account_number',
          'account_name',
        ],
        rows.map((row) => ({ cents: row.amount ?? 0, currency: home })),
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
          currency: invoices.currency,
          subtotal: invoices.subtotalCents,
          tax: invoices.taxCents,
          total: invoices.totalCents,
          balance: invoices.balanceCents,
          functionalTotal: invoices.functionalTotalCents,
          functionalBalance: invoices.functionalBalanceCents,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(eq(invoices.companyId, ctx.companyId))
        .orderBy(asc(invoices.issueDate))

      /*
        Both the issued amount and what it was booked at. The functional
        figures are read from the row, never recomputed: re-deriving them here
        would restate a March invoice at today's rate, which is wrong and is
        what Phase 35 stored rates to prevent.

        Subtotal and tax have no stored functional counterpart, so they carry
        the document currency and no functional column — a blank there would
        read as "nil" rather than "not held".
      */
      return file(
        'invoices.csv',
        rows.map((row) => ({
          number: row.number,
          customer: row.customer,
          issue_date: row.issue_date,
          due_date: row.due_date,
          status: row.status,
          subtotal: decimal(row.subtotal),
          tax: decimal(row.tax),
          ...spread('total', moneyColumns(
            { cents: row.total ?? 0, currency: row.currency },
            { cents: row.functionalTotal ?? row.total ?? 0, currency: home },
          )),
          ...spread('balance', moneyColumns(
            { cents: row.balance ?? 0, currency: row.currency },
            { cents: row.functionalBalance ?? row.balance ?? 0, currency: home },
          )),
        })),
        [
          'number',
          'customer',
          'issue_date',
          'due_date',
          'status',
          'subtotal',
          'tax',
          ...columnsFor('total'),
          ...columnsFor('balance'),
        ],
        rows.map((row) => ({ cents: row.total ?? 0, currency: row.currency })),
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
          currency: bills.currency,
          total: bills.totalCents,
          balance: bills.balanceCents,
          functionalTotal: bills.functionalTotalCents,
          functionalBalance: bills.functionalBalanceCents,
        })
        .from(bills)
        .innerJoin(vendors, eq(vendors.id, bills.vendorId))
        .where(eq(bills.companyId, ctx.companyId))
        .orderBy(asc(bills.issueDate))

      return file(
        'bills.csv',
        rows.map((row) => ({
          number: row.number,
          vendor: row.vendor,
          issue_date: row.issue_date,
          due_date: row.due_date,
          status: row.status,
          ...spread('total', moneyColumns(
            { cents: row.total ?? 0, currency: row.currency },
            { cents: row.functionalTotal ?? row.total ?? 0, currency: home },
          )),
          ...spread('balance', moneyColumns(
            { cents: row.balance ?? 0, currency: row.currency },
            { cents: row.functionalBalance ?? row.balance ?? 0, currency: home },
          )),
        })),
        [
          'number',
          'vendor',
          'issue_date',
          'due_date',
          'status',
          ...columnsFor('total'),
          ...columnsFor('balance'),
        ],
        rows.map((row) => ({ cents: row.total ?? 0, currency: row.currency })),
      )
    }

    case 'payments': {
      const rows = await db
        .select({
          payment_date: payments.paymentDate,
          kind: payments.kind,
          currency: payments.currency,
          amount: payments.amountCents,
          rate: payments.exchangeRateMillionths,
          reference: payments.reference,
          memo: payments.memo,
        })
        .from(payments)
        .where(scoped(ctx, payments))
        .orderBy(asc(payments.paymentDate))

      /*
        Unlike an invoice or a bill, a payment stores no functional amount for
        the whole receipt — only `functional_unapplied_cents` for the part not
        yet spent (Phase 65) — so the functional column here is derived.

        It is derived with `convert`, the same function the rest of the system
        uses, from the rate **the payment itself recorded**. That is not the
        same as recomputing at today's rate, which would restate a March
        receipt and is what Phase 35 stored rates to prevent. The rate is
        exported beside it so the arithmetic is checkable rather than trusted.
      */
      return file(
        'payments.csv',
        rows.map((row) => ({
          payment_date: row.payment_date,
          kind: row.kind,
          ...spread('amount', moneyColumns(
            { cents: row.amount ?? 0, currency: row.currency },
            { cents: convert(row.amount ?? 0, row.rate ?? MILLION), currency: home },
          )),
          exchange_rate: describeRate(row.rate ?? MILLION),
          reference: row.reference,
          memo: row.memo,
        })),
        ['payment_date', 'kind', ...columnsFor('amount'), 'exchange_rate', 'reference', 'memo'],
        rows.map((row) => ({ cents: row.amount ?? 0, currency: row.currency })),
      )
    }
  }
}

/**
 * One CSV, and what its money adds up to per currency.
 *
 * `money` is the amounts that make this file's headline figure — the invoice
 * totals, not every column on the row. A file with none is a list rather than a
 * ledger, and the manifest says so rather than showing a zero.
 */
function file(
  name: string,
  rows: Array<Record<string, unknown>>,
  columns: string[],
  money: Money[] = [],
): ExportedFile {
  return {
    name,
    content: toCsv(rows, columns),
    rowCount: rows.length,
    currencies: tally(money),
  }
}

/** Previous exports, so "who took a copy" is answerable from the UI. */
export async function listExports(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'reports:financial')

  return db
    .select()
    .from(dataExports)
    .where(scoped(ctx, dataExports))
    // Newest first. This ordered `asc` until Phase 103, so the security page —
    // which asks for ten — answered "who took a copy of everything" with the
    // first ten exports the company ever took, and stopped changing after
    // that. A panel that renders, looks right, and can never show this
    // morning's export.
    .orderBy(desc(dataExports.createdAt))
    .limit(opts.limit ?? 20)
}
