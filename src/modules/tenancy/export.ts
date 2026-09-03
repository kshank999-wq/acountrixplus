import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  bills,
  chartAccounts,
  creditNotes,
  customers,
  dataExports,
  giftCards,
  invoices,
  journalEntries,
  journalLines,
  payments,
  bankTransactions,
  retainers,
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

/**
 * Every dataset, declared exactly once (Phase 104).
 *
 * `DatasetName`, `DATASETS` and this record used to be three parallel
 * hand-written structures, and only one of them was checked: a
 * `Record<DatasetName, string>` cannot miss an entry, but `DATASETS` was a
 * plain array and could. A dataset added to the union, the labels and the
 * switch but forgotten in `DATASETS` would compile, be selectable by name, and
 * silently never appear in the default export — a missing file in somebody's
 * leaving archive, found by its absence.
 *
 * So the labels are the declaration. The union is its keys and the list is
 * derived, which leaves `buildDataset`'s switch as the only other place that
 * has to know, and TypeScript already checks that against the union.
 *
 * Order is insertion order, so the files come out in the same sequence every
 * time and an export can be diffed against an earlier one.
 */
export const DATASET_LABELS = {
  chart_of_accounts: 'Chart of accounts',
  journal: 'Journal entries and lines',
  bank_transactions: 'Bank transactions',
  customers: 'Customers',
  invoices: 'Invoices',
  vendors: 'Vendors',
  bills: 'Bills',
  payments: 'Payments',
  // What the company is holding that belongs to somebody else (Phase 104).
  retainers: 'Retainers held on account',
  credit_notes: 'Credit notes',
  gift_cards: 'Gift cards in issue',
} as const

export type DatasetName = keyof typeof DATASET_LABELS

export const DATASETS: DatasetName[] = Object.keys(DATASET_LABELS) as DatasetName[]

/**
 * The datasets, as a sentence for the screen that offers the export.
 *
 * Derived rather than written out, because the blurb on the security page was
 * a *fourth* hand-written copy of this list — "the chart of accounts, the
 * journal, bank transactions, customers, invoices, vendors, bills, and
 * payments" — and adding three datasets made it quietly wrong. A promise about
 * what a file contains is worth keeping true.
 */
export function datasetSentence(): string {
  const names = DATASETS.map((dataset) => {
    const label = DATASET_LABELS[dataset]
    return label.charAt(0).toLowerCase() + label.slice(1)
  })

  const last = names[names.length - 1]
  return `${names.slice(0, -1).join(', ')} and ${last}`
}

export type ExportedFile = {
  name: string
  content: string
  rowCount: number
  /**
   * What each currency in this file sums to, for the manifest.
   *
   * Three distinct states, deliberately: `null` for a file with no money in it
   * at all, `[]` for one that has money columns and no rows, and entries for
   * one that has both. The first two produced the same sentence until Phase
   * 104, which told the reader of an empty `gift_cards.csv` that it had no
   * money columns when it has four.
   */
  currencies: CurrencyTally[] | null
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
    file.currencies === null || file.currencies.length === 0
      ? [{ file: file.name, currency: '', rows: String(file.rowCount), total: '', note: summarise(file.name, file.currencies) }]
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
    currencies: null,
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

    /*
      The three below are what the company is holding that belongs to somebody
      else (Phase 104). Until then the export answered "what are we owed" and
      "what do we owe suppliers" and said nothing about money on account: the
      ledger showed a liability balance and the trail stopped there, so a
      leaving company could not say whose 12,400 it was holding.

      Each tallies its **remaining** balance rather than what was issued, so
      the manifest figure is the one that should tie to the liability account
      in `journal.csv` — the reconciliation an accountant does first.
    */
    case 'retainers': {
      const rows = await db
        .select({
          customer: customers.name,
          received_on: retainers.receivedOn,
          reference: retainers.reference,
          currency: retainers.currency,
          amount: retainers.amountCents,
          rate: retainers.exchangeRateMillionths,
          remaining: retainers.remainingCents,
          functionalRemaining: retainers.functionalRemainingCents,
        })
        .from(retainers)
        .innerJoin(customers, eq(customers.id, retainers.customerId))
        .where(eq(retainers.companyId, ctx.companyId))
        .orderBy(asc(retainers.receivedOn))

      return file(
        'retainers.csv',
        rows.map((row) => ({
          customer: row.customer,
          received_on: row.received_on,
          reference: row.reference,
          // Like a payment, a retainer stores a functional figure only for
          // what is *left*; the amount received is derived from the rate the
          // money came in at, which the row has carried since (Phase 66).
          ...spread('amount', moneyColumns(
            { cents: row.amount ?? 0, currency: row.currency },
            { cents: convert(row.amount ?? 0, row.rate ?? MILLION), currency: home },
          )),
          ...spread('remaining', moneyColumns(
            { cents: row.remaining ?? 0, currency: row.currency },
            { cents: row.functionalRemaining ?? 0, currency: home },
          )),
          exchange_rate: describeRate(row.rate ?? MILLION),
        })),
        [
          'customer',
          'received_on',
          'reference',
          ...columnsFor('amount'),
          ...columnsFor('remaining'),
          'exchange_rate',
        ],
        rows.map((row) => ({ cents: row.remaining ?? 0, currency: row.currency })),
      )
    }

    case 'credit_notes': {
      const rows = await db
        .select({
          number: creditNotes.number,
          party: creditNotes.party,
          customer: customers.name,
          vendor: vendors.name,
          issue_date: creditNotes.issueDate,
          status: creditNotes.status,
          currency: creditNotes.currency,
          total: creditNotes.totalCents,
          functionalTotal: creditNotes.functionalTotalCents,
          remaining: creditNotes.remainingCents,
          functionalRemaining: creditNotes.functionalRemainingCents,
        })
        .from(creditNotes)
        .leftJoin(customers, eq(customers.id, creditNotes.customerId))
        .leftJoin(vendors, eq(vendors.id, creditNotes.vendorId))
        .where(eq(creditNotes.companyId, ctx.companyId))
        .orderBy(asc(creditNotes.issueDate))

      return file(
        'credit_notes.csv',
        rows.map((row) => ({
          number: row.number,
          // Which side of the books this credit is on, and the one name that
          // goes with it. Exactly one of the two joins matches, by the same
          // constraint that keeps `party` honest.
          party: row.party,
          party_name: row.party === 'vendor' ? row.vendor : row.customer,
          issue_date: row.issue_date,
          status: row.status,
          ...spread('total', moneyColumns(
            { cents: row.total ?? 0, currency: row.currency },
            { cents: row.functionalTotal ?? row.total ?? 0, currency: home },
          )),
          ...spread('remaining', moneyColumns(
            { cents: row.remaining ?? 0, currency: row.currency },
            { cents: row.functionalRemaining ?? row.remaining ?? 0, currency: home },
          )),
        })),
        [
          'number',
          'party',
          'party_name',
          'issue_date',
          'status',
          ...columnsFor('total'),
          ...columnsFor('remaining'),
        ],
        rows.map((row) => ({ cents: row.remaining ?? 0, currency: row.currency })),
      )
    }

    case 'gift_cards': {
      const rows = await db
        .select({
          code: giftCards.code,
          purchaser: customers.name,
          issued_on: giftCards.issuedOn,
          is_active: giftCards.isActive,
          issued: giftCards.issuedCents,
          balance: giftCards.balanceCents,
        })
        .from(giftCards)
        .leftJoin(customers, eq(customers.id, giftCards.purchaserCustomerId))
        .where(eq(giftCards.companyId, ctx.companyId))
        .orderBy(asc(giftCards.issuedOn))

      /*
        A gift card names no owner, and that is what a gift card *is* rather
        than a gap in the schema: `purchaser_customer_id` is who paid, and who
        will spend it is whoever holds the code. The column is named
        `purchaser` for that reason — calling it `customer` would be a
        plausible-looking wrong answer.

        `gift_cards` has no currency column, having been built in Phase 29
        before the currency work, so every balance is in the company's own
        money by construction and the file says so.
      */
      return file(
        'gift_cards.csv',
        rows.map((row) => ({
          code: row.code,
          purchaser: row.purchaser,
          issued_on: row.issued_on,
          is_active: row.is_active,
          ...spread('issued', moneyColumns({ cents: row.issued ?? 0, currency: home })),
          ...spread('balance', moneyColumns({ cents: row.balance ?? 0, currency: home })),
        })),
        [
          'code',
          'purchaser',
          'issued_on',
          'is_active',
          ...columnsFor('issued'),
          ...columnsFor('balance'),
        ],
        rows.map((row) => ({ cents: row.balance ?? 0, currency: home })),
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
  money: Money[] | null = null,
): ExportedFile {
  return {
    name,
    content: toCsv(rows, columns),
    rowCount: rows.length,
    // Null stays null: a file with no money concept is not the same as one
    // whose money happens to be zero rows long.
    currencies: money === null ? null : tally(money),
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
