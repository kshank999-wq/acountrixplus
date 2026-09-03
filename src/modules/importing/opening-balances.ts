import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  chartAccounts,
  customers,
  importRecords,
  importRuns,
  invoices,
  invoiceLines,
  bills,
  billLines,
  journalEntries,
  journalLines,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { accountByNumber } from '@/modules/coa/service'
import { createJournalEntry } from '@/modules/ledger/journal'
import { readSheet, rowToRecord } from './csv'
import { cleanText, isAmbiguousDate, parseDateISO, parseMoneyCents, type DateOrder } from './coerce'
import {
  OPEN_DOCUMENT_FIELDS,
  TRIAL_BALANCE_FIELDS,
  proposeMapping,
  valueFor,
} from './mapping'
import { contactKey } from './contacts'
import {
  finishPlan,
  ImportNotReadyError,
  summarizeProblems,
  type ImportPlan,
  type PlannedRow,
  type RowProblem,
} from './plan'

/**
 * Opening balances (spec §20 Phase 8).
 *
 * ## The account that has been waiting since Phase 0
 *
 * `3900 Opening Balance Equity` has been in the standard chart since the first
 * commit, described as "Offsets opening balances during setup. Should clear to
 * zero." Nothing has ever written to it. This is what it was for.
 *
 * The migration has a shape, and the shape is the point:
 *
 *  1. The **trial balance** goes in as one journal entry. Every account gets
 *     its closing balance from the old system, and `Opening Balance Equity`
 *     takes the other side of every line.
 *  2. **Except Accounts Receivable and Accounts Payable**, which the trial
 *     balance names and this deliberately does not post. Their balances come
 *     from the open documents, one row each — because a receivable is not a
 *     number, it is a list of people who owe you, and a migration that brings
 *     across the total without the list produces an aging report that agrees
 *     with nothing.
 *  3. The **open invoices and bills** go in as documents, each posting
 *     `Dr Accounts Receivable / Cr Opening Balance Equity`. This is where the
 *     receivable enters the ledger, and the equity account is what it
 *     displaces.
 *  4. If the detail agrees with the trial balance, **Opening Balance Equity
 *     nets to zero**, and the books are open.
 *
 * That last line is the claim, and its value is in the failure case. A
 * non-zero Opening Balance Equity is not a mystery — it is exactly the amount
 * by which the customer detail disagrees with the receivables figure the old
 * system reported, which is the commonest defect in a migration and normally
 * surfaces months later as an aging report nobody can tie out.
 *
 * Posting the control accounts from *both* the trial balance and the detail
 * was the first thing this module did, and it doubled the receivable. The
 * arithmetic looked right in isolation and was wrong the moment both files
 * were imported, which is why the end-to-end test exists.
 */

export type PlannedBalance = {
  number: string
  accountId: string
  accountName: string
  /** Debit-positive. A credit balance is negative. */
  amountCents: number
}

export type TrialBalancePlan = ImportPlan<PlannedBalance> & {
  /** Every row of the file, control accounts included. This is what must balance. */
  fileDebitCents: number
  fileCreditCents: number
  /** Only the lines that will actually be posted — control accounts excluded. */
  totalDebitCents: number
  totalCreditCents: number
  /** The claim's precondition. A trial balance that does not balance is not one. */
  balances: boolean
  /** What the file said receivables and payables were, for checking the detail. */
  receivableControlCents: number | null
  payableControlCents: number | null
}

export async function planTrialBalanceImport(
  ctx: ActorContext,
  input: { text: string; columns?: Record<string, string | null> },
): Promise<TrialBalancePlan> {
  requirePermission(ctx, 'accounting:journal')

  const sheet = readSheet(input.text)
  const proposed = proposeMapping(sheet.headers, TRIAL_BALANCE_FIELDS)
  const columns = input.columns ?? proposed.columns

  const fileProblems: RowProblem[] = []
  if (!columns.number) {
    fileProblems.push({
      row: 0,
      field: 'number',
      message: 'No column is mapped to Account number.',
      severity: 'error',
    })
  }

  // Either a debit/credit pair or one signed balance column. Both is fine —
  // the pair wins — but neither is unreadable.
  const hasPair = Boolean(columns.debit || columns.credit)
  const hasBalance = Boolean(columns.balance)
  if (!hasPair && !hasBalance) {
    fileProblems.push({
      row: 0,
      message:
        'No amount column. Map either a Debit and Credit pair, or a single signed Balance column.',
      severity: 'error',
    })
  }

  const accounts = await db
    .select({ id: chartAccounts.id, number: chartAccounts.number, name: chartAccounts.name })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts))

  const byNumber = new Map(accounts.map((account) => [account.number, account]))
  const openingEquity = byNumber.get(SYSTEM_ACCOUNTS.openingBalanceEquity)

  if (!openingEquity) {
    fileProblems.push({
      row: 0,
      message: `No ${SYSTEM_ACCOUNTS.openingBalanceEquity} Opening Balance Equity account. Opening balances have nowhere to offset against.`,
      severity: 'error',
    })
  }

  const rows: Array<PlannedRow<PlannedBalance>> = []
  const seenInFile = new Map<string, number>()
  let totalDebitCents = 0
  let totalCreditCents = 0
  let fileDebitCents = 0
  let fileCreditCents = 0
  let receivableControlCents: number | null = null
  let payableControlCents: number | null = null

  sheet.rows.forEach((raw, index) => {
    const row = index + 1
    const record = rowToRecord(sheet.headers, raw)
    const problems: RowProblem[] = []

    const number = cleanText(valueFor(record, columns, 'number'))
    if (number === '') {
      problems.push({ row, field: 'number', message: 'No account number.', severity: 'error' })
    }

    const account = byNumber.get(number)
    if (number !== '' && !account) {
      problems.push({
        row,
        field: 'number',
        message: `There is no account ${number} on these books. Import the chart of accounts first.`,
        severity: 'error',
      })
    }

    // Three accounts a trial balance names and this does not post.
    //
    // Opening Balance Equity is what everything else offsets against, so its
    // own line would be counted twice. Receivables and payables come from the
    // open documents instead — see the module note.
    if (openingEquity && number === openingEquity.number) {
      problems.push({
        row,
        message:
          'Opening Balance Equity is what the other balances offset against, so its own balance is ignored.',
        severity: 'warning',
      })
    } else if (number === SYSTEM_ACCOUNTS.accountsReceivable) {
      problems.push({
        row,
        message:
          'Accounts Receivable is built from the open invoices, not from this line — otherwise the receivable would be counted twice. This figure is kept to check the detail against.',
        severity: 'warning',
      })
    } else if (number === SYSTEM_ACCOUNTS.accountsPayable) {
      problems.push({
        row,
        message:
          'Accounts Payable is built from the open bills, not from this line. This figure is kept to check the detail against.',
        severity: 'warning',
      })
    }

    const firstSeenAt = seenInFile.get(number)
    if (number !== '' && firstSeenAt !== undefined) {
      problems.push({
        row,
        field: 'number',
        message: `Account ${number} appears twice in this file — also at row ${firstSeenAt}.`,
        severity: 'error',
      })
    } else if (number !== '') {
      seenInFile.set(number, row)
    }

    const isControl =
      number === SYSTEM_ACCOUNTS.accountsReceivable || number === SYSTEM_ACCOUNTS.accountsPayable
    const isOffset = openingEquity !== undefined && number === openingEquity.number

    const amountCents = readAmount(record, columns, row, problems)

    if (amountCents !== null && account) {
      if (number === SYSTEM_ACCOUNTS.accountsReceivable) receivableControlCents = amountCents
      if (number === SYSTEM_ACCOUNTS.accountsPayable) payableControlCents = -amountCents

      // The balance check covers the file as written. Excluding the control
      // accounts here would declare a trial balance sound when the very lines
      // this refuses to post are the ones that do not foot.
      if (!isOffset) {
        if (amountCents > 0) fileDebitCents += amountCents
        else fileCreditCents += -amountCents
      }
    }

    const parsed: PlannedBalance | null =
      account && amountCents !== null && !isOffset && !isControl
        ? {
            number,
            accountId: account.id,
            accountName: account.name,
            amountCents,
          }
        : null

    if (parsed) {
      if (parsed.amountCents > 0) totalDebitCents += parsed.amountCents
      else totalCreditCents += -parsed.amountCents
    }

    rows.push({
      row,
      parsed,
      // Every row of a trial balance is a line of one entry — nothing is
      // created or updated on its own, so a zero balance is simply skipped.
      action: parsed && parsed.amountCents !== 0 ? 'create' : 'skip',
      problems,
    })
  })

  const balances = fileDebitCents === fileCreditCents

  if (!balances && fileProblems.every((problem) => problem.severity !== 'error')) {
    fileProblems.push({
      row: 0,
      message:
        `This trial balance does not balance: debits ${formatPlain(fileDebitCents)} against ` +
        `credits ${formatPlain(fileCreditCents)}, a difference of ` +
        `${formatPlain(Math.abs(fileDebitCents - fileCreditCents))}. ` +
        'A trial balance that does not balance cannot be an opening position.',
      severity: 'error',
    })
  }

  const plan = finishPlan({
    headers: sheet.headers,
    columns,
    delimiter: sheet.delimiter,
    rows,
    fileProblems,
    blankRowsSkipped: sheet.blankRowsSkipped,
  })

  return {
    ...plan,
    fileDebitCents,
    fileCreditCents,
    totalDebitCents,
    totalCreditCents,
    balances,
    receivableControlCents,
    payableControlCents,
  }
}

/**
 * Reads either a debit/credit pair or a signed balance.
 *
 * A row carrying both a debit and a credit is a real error rather than a sum:
 * a trial balance line is one side or the other, and a row with both means the
 * columns are misaligned — which, added together, would look plausible and be
 * wrong.
 */
function readAmount(
  record: Record<string, string>,
  columns: Record<string, string | null>,
  row: number,
  problems: RowProblem[],
): number | null {
  const debitRaw = valueFor(record, columns, 'debit')
  const creditRaw = valueFor(record, columns, 'credit')
  const balanceRaw = valueFor(record, columns, 'balance')

  const hasDebit = debitRaw.trim() !== '' && debitRaw.trim() !== '-'
  const hasCredit = creditRaw.trim() !== '' && creditRaw.trim() !== '-'

  if (hasDebit && hasCredit) {
    problems.push({
      row,
      message: 'This row has both a debit and a credit. One line of a trial balance is one or the other.',
      severity: 'error',
    })
    return null
  }

  if (hasDebit || hasCredit) {
    const raw = hasDebit ? debitRaw : creditRaw
    const cents = parseMoneyCents(raw)
    if (cents === null) {
      problems.push({
        row,
        field: hasDebit ? 'debit' : 'credit',
        message: `“${cleanText(raw)}” is not an amount.`,
        severity: 'error',
      })
      return null
    }
    return hasDebit ? cents : -cents
  }

  if (balanceRaw.trim() !== '') {
    const cents = parseMoneyCents(balanceRaw)
    if (cents === null) {
      problems.push({
        row,
        field: 'balance',
        message: `“${cleanText(balanceRaw)}” is not an amount.`,
        severity: 'error',
      })
      return null
    }
    return cents
  }

  // No amount at all is a heading or a spacer row, not a mistake.
  return 0
}

export async function commitTrialBalanceImport(
  ctx: ActorContext,
  plan: TrialBalancePlan,
  input: { asOfDate: string; fileName?: string },
): Promise<{ runId: string; entryId: string; entryNumber: number; lineCount: number }> {
  requirePermission(ctx, 'accounting:journal')

  if (!plan.canCommit) throw new ImportNotReadyError(plan.counts.errors)

  const lines = plan.rows
    .map((row) => row.parsed)
    .filter((balance): balance is PlannedBalance => balance !== null && balance.amountCents !== 0)

  if (lines.length === 0) throw new ImportNotReadyError(0)

  return db.transaction(async (tx) => {
    const openingEquity = await accountByNumber(
      ctx.companyId,
      SYSTEM_ACCOUNTS.openingBalanceEquity,
      tx,
    )
    if (!openingEquity) throw new Error('No Opening Balance Equity account is set up.')

    const debitTotal = lines.filter((l) => l.amountCents > 0).reduce((s, l) => s + l.amountCents, 0)
    const creditTotal = lines.filter((l) => l.amountCents < 0).reduce((s, l) => s - l.amountCents, 0)

    // The plan has already asserted these are equal. Belt and braces, because
    // the alternative is an unbalanced ledger and this is the one write in the
    // application that touches every account at once.
    const plugCents = debitTotal - creditTotal

    const entryLines = lines.map((line) => ({
      chartAccountId: line.accountId,
      debitCents: line.amountCents > 0 ? line.amountCents : undefined,
      creditCents: line.amountCents < 0 ? -line.amountCents : undefined,
      memo: `Opening balance — ${line.number} ${line.accountName}`,
    }))

    if (plugCents !== 0) {
      entryLines.push({
        chartAccountId: openingEquity.id,
        debitCents: plugCents < 0 ? -plugCents : undefined,
        creditCents: plugCents > 0 ? plugCents : undefined,
        memo: 'Opening Balance Equity',
      })
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.asOfDate,
        memo: `Opening balances as at ${input.asOfDate}`,
        source: 'adjusting',
        sourceType: 'opening_balances',
        lines: entryLines,
      },
      tx,
    )

    const [run] = await tx
      .insert(importRuns)
      .values({
        companyId: ctx.companyId,
        kind: 'trial_balance',
        fileName: input.fileName ?? null,
        headers: JSON.stringify(plan.headers),
        columnMapping: JSON.stringify(plan.columns),
        rowCount: plan.counts.total,
        createdCount: lines.length,
        skippedCount: plan.counts.willSkip,
        totalCents: debitTotal,
        journalEntryId: entry.id,
        receivableControlCents: plan.receivableControlCents,
        payableControlCents: plan.payableControlCents,
        notes: JSON.stringify(summarizeProblems(plan.rows.flatMap((row) => row.problems))),
        createdBy: ctx.userId,
      })
      .returning({ id: importRuns.id })

    await recordAudit(
      ctx,
      {
        action: 'import.commit',
        entityType: 'import_run',
        entityId: run.id,
        after: {
          kind: 'trial_balance',
          asOfDate: input.asOfDate,
          lines: lines.length,
          totalCents: debitTotal,
        },
      },
      tx,
    )

    return { runId: run.id, entryId: entry.id, entryNumber: entry.entryNumber, lineCount: lines.length }
  })
}

// --- Open invoices and bills ------------------------------------------------

export type PlannedDocument = {
  partyName: string
  partyId: string | null
  number: string
  issueDate: string
  dueDate: string
  amountCents: number
  memo: string | null
}

export type OpenDocumentPlan = ImportPlan<PlannedDocument> & {
  totalCents: number
  /** Names in the file that match no customer or vendor on the books. */
  unknownParties: string[]
}

export async function planOpenDocumentImport(
  ctx: ActorContext,
  input: {
    kind: 'open_invoices' | 'open_bills'
    text: string
    columns?: Record<string, string | null>
    dateOrder?: DateOrder
  },
): Promise<OpenDocumentPlan> {
  requirePermission(ctx, 'accounting:journal')

  const sheet = readSheet(input.text)
  const proposed = proposeMapping(sheet.headers, OPEN_DOCUMENT_FIELDS)
  const columns = input.columns ?? proposed.columns
  const dateOrder = input.dateOrder ?? 'mdy'

  const fileProblems: RowProblem[] = []
  for (const field of OPEN_DOCUMENT_FIELDS) {
    if (field.required && !columns[field.key]) {
      fileProblems.push({
        row: 0,
        field: field.key,
        message: `No column is mapped to ${field.label}.`,
        severity: 'error',
      })
    }
  }

  const table = input.kind === 'open_invoices' ? customers : vendors
  const parties = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(scoped(ctx, table))

  const byKey = new Map(parties.map((party) => [contactKey(party.name), party]))
  const rows: Array<PlannedRow<PlannedDocument>> = []
  const unknownParties = new Set<string>()
  const seenNumbers = new Map<string, number>()
  let totalCents = 0
  let ambiguousDates = 0

  sheet.rows.forEach((raw, index) => {
    const row = index + 1
    const record = rowToRecord(sheet.headers, raw)
    const problems: RowProblem[] = []

    const partyName = cleanText(valueFor(record, columns, 'party'))
    const number = cleanText(valueFor(record, columns, 'number'))
    const dateRaw = valueFor(record, columns, 'date')
    const dueRaw = valueFor(record, columns, 'dueDate')
    const amountRaw = valueFor(record, columns, 'amount')

    if (partyName === '') {
      problems.push({ row, field: 'party', message: 'No customer or vendor name.', severity: 'error' })
    }
    if (number === '') {
      problems.push({ row, field: 'number', message: 'No document number.', severity: 'error' })
    }

    const party = partyName === '' ? undefined : byKey.get(contactKey(partyName))
    if (partyName !== '' && !party) {
      unknownParties.add(partyName)
      problems.push({
        row,
        field: 'party',
        message: `“${partyName}” is not on these books yet. Import ${
          input.kind === 'open_invoices' ? 'customers' : 'vendors'
        } first.`,
        severity: 'error',
      })
    }

    if (isAmbiguousDate(dateRaw)) ambiguousDates += 1

    const issueDate = parseDateISO(dateRaw, dateOrder)
    if (!issueDate) {
      problems.push({
        row,
        field: 'date',
        message:
          dateRaw.trim() === '' ? 'No date.' : `“${cleanText(dateRaw)}” is not a date this can read.`,
        severity: 'error',
      })
    }

    const dueDate = dueRaw.trim() === '' ? issueDate : parseDateISO(dueRaw, dateOrder)
    if (dueRaw.trim() !== '' && !dueDate) {
      problems.push({
        row,
        field: 'dueDate',
        message: `“${cleanText(dueRaw)}” is not a date this can read.`,
        severity: 'warning',
      })
    }
    if (issueDate && dueDate && dueDate < issueDate) {
      problems.push({
        row,
        field: 'dueDate',
        message: 'The due date is before the document date.',
        severity: 'warning',
      })
    }

    const amountCents = parseMoneyCents(amountRaw)
    if (amountCents === null) {
      problems.push({
        row,
        field: 'amount',
        message:
          amountRaw.trim() === ''
            ? 'No amount outstanding.'
            : `“${cleanText(amountRaw)}” is not an amount.`,
        severity: 'error',
      })
    } else if (amountCents <= 0) {
      // A fully-settled document has nothing to open, and a credit balance is
      // a credit note rather than an invoice.
      problems.push({
        row,
        field: 'amount',
        message:
          amountCents === 0
            ? 'Nothing outstanding, so there is nothing to bring across.'
            : 'A negative outstanding amount is a credit note, which this import does not create.',
        severity: amountCents === 0 ? 'warning' : 'error',
      })
    }

    const duplicateAt = number === '' ? undefined : seenNumbers.get(`${contactKey(partyName)}:${number}`)
    if (duplicateAt !== undefined) {
      problems.push({
        row,
        field: 'number',
        message: `${number} for “${partyName}” appears twice in this file — also at row ${duplicateAt}.`,
        severity: 'error',
      })
    } else if (number !== '') {
      seenNumbers.set(`${contactKey(partyName)}:${number}`, row)
    }

    const usable =
      party && issueDate && amountCents !== null && amountCents > 0 && number !== '' && duplicateAt === undefined

    const parsed: PlannedDocument | null = usable
      ? {
          partyName,
          partyId: party.id,
          number,
          issueDate,
          dueDate: dueDate ?? issueDate,
          amountCents,
          memo: cleanText(valueFor(record, columns, 'memo')) || null,
        }
      : null

    if (parsed) totalCents += parsed.amountCents

    rows.push({ row, parsed, action: parsed ? 'create' : 'skip', problems })
  })

  // A warning about the whole file rather than about a row: a date order read
  // the wrong way puts half a year of documents in the wrong month, every one
  // of them plausible, and nothing else would ever flag it.
  if (ambiguousDates > 0) {
    fileProblems.push({
      row: 0,
      message:
        `${ambiguousDates} ${ambiguousDates === 1 ? 'date could' : 'dates could'} be read two ways — ` +
        `they are being read as ${dateOrder === 'mdy' ? 'month/day/year' : 'day/month/year'}. ` +
        'Check a row you recognise before committing.',
      severity: 'warning',
    })
  }

  const plan = finishPlan({
    headers: sheet.headers,
    columns,
    delimiter: sheet.delimiter,
    rows,
    fileProblems,
    blankRowsSkipped: sheet.blankRowsSkipped,
  })

  return { ...plan, totalCents, unknownParties: [...unknownParties] }
}

/**
 * Brings open documents across as real invoices and bills.
 *
 * Each posts against **Opening Balance Equity**, not against revenue. The sale
 * happened in the old system and was reported there; recognising it again here
 * would double the company's lifetime revenue and put a year's trading into
 * whatever month the migration happened.
 *
 * The receivable is already in the trial balance as a single figure, so this
 * detail displaces that figure rather than adding to it — which is why the two
 * offset each other and why Opening Balance Equity clearing to zero means the
 * detail and the control account agree.
 */
export async function commitOpenDocumentImport(
  ctx: ActorContext,
  kind: 'open_invoices' | 'open_bills',
  plan: OpenDocumentPlan,
  meta: { fileName?: string } = {},
): Promise<{ runId: string; created: number; totalCents: number }> {
  requirePermission(ctx, 'accounting:journal')

  if (!plan.canCommit) throw new ImportNotReadyError(plan.counts.errors)

  const documents = plan.rows
    .map((row) => ({ row: row.row, parsed: row.parsed }))
    .filter((entry): entry is { row: number; parsed: PlannedDocument } => entry.parsed !== null)

  if (documents.length === 0) throw new ImportNotReadyError(0)

  return db.transaction(async (tx) => {
    const isReceivable = kind === 'open_invoices'

    const [controlAccount, openingEquity] = await Promise.all([
      accountByNumber(
        ctx.companyId,
        isReceivable ? SYSTEM_ACCOUNTS.accountsReceivable : SYSTEM_ACCOUNTS.accountsPayable,
        tx,
      ),
      accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.openingBalanceEquity, tx),
    ])

    if (!controlAccount) throw new Error('The control account is missing from the chart.')
    if (!openingEquity) throw new Error('No Opening Balance Equity account is set up.')

    const [run] = await tx
      .insert(importRuns)
      .values({
        companyId: ctx.companyId,
        kind,
        fileName: meta.fileName ?? null,
        headers: JSON.stringify(plan.headers),
        columnMapping: JSON.stringify(plan.columns),
        rowCount: plan.counts.total,
        createdCount: documents.length,
        skippedCount: plan.counts.willSkip,
        totalCents: plan.totalCents,
        notes: JSON.stringify(summarizeProblems(plan.rows.flatMap((row) => row.problems))),
        createdBy: ctx.userId,
      })
      .returning({ id: importRuns.id })

    let created = 0
    let totalCents = 0

    for (const { row, parsed } of documents) {
      const entry = await createJournalEntry(
        ctx,
        {
          entryDate: parsed.issueDate,
          memo: `Opening ${isReceivable ? 'invoice' : 'bill'} ${parsed.number} — ${parsed.partyName}`,
          source: 'adjusting',
          sourceType: isReceivable ? 'opening_invoice' : 'opening_bill',
          lines: isReceivable
            ? [
                { chartAccountId: controlAccount.id, debitCents: parsed.amountCents },
                { chartAccountId: openingEquity.id, creditCents: parsed.amountCents },
              ]
            : [
                { chartAccountId: openingEquity.id, debitCents: parsed.amountCents },
                { chartAccountId: controlAccount.id, creditCents: parsed.amountCents },
              ],
        },
        tx,
      )

      const documentId = isReceivable
        ? await insertOpeningInvoice(ctx, tx, parsed, entry.id, openingEquity.id)
        : await insertOpeningBill(ctx, tx, parsed, entry.id, openingEquity.id)

      await tx.insert(importRecords).values({
        companyId: ctx.companyId,
        importRunId: run.id,
        entityType: isReceivable ? 'invoice' : 'bill',
        entityId: documentId,
        action: 'created',
        sourceRow: row,
      })

      created += 1
      totalCents += parsed.amountCents
    }

    await recordAudit(
      ctx,
      {
        action: 'import.commit',
        entityType: 'import_run',
        entityId: run.id,
        after: { kind, created, totalCents, fileName: meta.fileName ?? null },
      },
      tx,
    )

    return { runId: run.id, created, totalCents }
  })
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function insertOpeningInvoice(
  ctx: ActorContext,
  tx: Tx,
  parsed: PlannedDocument,
  journalEntryId: string,
  openingEquityId: string,
): Promise<string> {
  const [invoice] = await tx
    .insert(invoices)
    .values({
      companyId: ctx.companyId,
      customerId: parsed.partyId as string,
      number: parsed.number,
      issueDate: parsed.issueDate,
      dueDate: parsed.dueDate,
      status: 'open',
      subtotalCents: parsed.amountCents,
      taxCents: 0,
      totalCents: parsed.amountCents,
      balanceCents: parsed.amountCents,
      /**
       * What the books carry it at (Phase 117).
       *
       * These two were never set, so every invoice the migration wizard ever
       * created defaulted to **zero** — and the functional figure is what the
       * rest of the system reads. The control-account check sums it (Phase 35),
       * the aging report ages it (Phase 107), statements and chasing quote it.
       * A migrated company therefore had receivables on its balance sheet, an
       * aging report showing nothing, a nightly fault, and statements telling
       * customers they owed nothing — ADR 0031's failure exactly, produced by
       * the first screen a new customer uses.
       *
       * An opening balance carries no currency of its own: it is what the old
       * system said was owed, in the money these books are kept in. So the rate
       * is one and the functional figure *is* the face figure.
       */
      functionalTotalCents: parsed.amountCents,
      functionalBalanceCents: parsed.amountCents,
      memo: parsed.memo,
      journalEntryId,
    })
    .returning({ id: invoices.id })

  await tx.insert(invoiceLines).values({
    companyId: ctx.companyId,
    invoiceId: invoice.id,
    description: parsed.memo ?? 'Opening balance brought forward',
    quantityMilli: 1000,
    unitPriceCents: parsed.amountCents,
    amountCents: parsed.amountCents,
    // The revenue was earned and reported in the old system. Pointing this
    // line at a revenue account would report it again here.
    chartAccountId: openingEquityId,
    sortOrder: 0,
  })

  return invoice.id
}

async function insertOpeningBill(
  ctx: ActorContext,
  tx: Tx,
  parsed: PlannedDocument,
  journalEntryId: string,
  openingEquityId: string,
): Promise<string> {
  const [bill] = await tx
    .insert(bills)
    .values({
      companyId: ctx.companyId,
      vendorId: parsed.partyId as string,
      number: parsed.number,
      issueDate: parsed.issueDate,
      dueDate: parsed.dueDate,
      status: 'open',
      subtotalCents: parsed.amountCents,
      taxCents: 0,
      totalCents: parsed.amountCents,
      balanceCents: parsed.amountCents,
      // The payables side of the same omission (Phase 117). See the invoice
      // above: an opening balance is in the money these books are kept in, so
      // the rate is one and the functional figure is the face figure.
      functionalTotalCents: parsed.amountCents,
      functionalBalanceCents: parsed.amountCents,
      memo: parsed.memo,
      journalEntryId,
    })
    .returning({ id: bills.id })

  await tx.insert(billLines).values({
    companyId: ctx.companyId,
    billId: bill.id,
    description: parsed.memo ?? 'Opening balance brought forward',
    quantityMilli: 1000,
    unitPriceCents: parsed.amountCents,
    amountCents: parsed.amountCents,
    chartAccountId: openingEquityId,
    sortOrder: 0,
  })

  return bill.id
}

export type OpeningReadiness = {
  openingBalanceEquityCents: number
  /** True when the migration is complete and consistent. */
  isClear: boolean
  /**
   * What the imported trial balance said receivables were, or null if no
   * trial balance has been imported.
   *
   * Deliberately *not* the Accounts Receivable account balance. That balance
   * is built from the open invoices, so comparing it to the open invoices
   * would compare a figure to itself and always agree — which is exactly the
   * check somebody needs and the one it would silently fail to perform.
   */
  receivablesReportedCents: number | null
  receivablesDetailCents: number
  receivablesAgree: boolean
  payablesReportedCents: number | null
  payablesDetailCents: number
  payablesAgree: boolean
  /** Plain-language explanation of what a non-zero balance means. */
  diagnosis: string
}

/**
 * Whether the migration is finished.
 *
 * Reads the three things that have to be true and, when they are not, says
 * which one — because "Opening Balance Equity is $4,312.18" is a symptom and
 * "your customer detail is $4,312.18 less than the receivables balance you
 * imported" is a thing somebody can go and fix.
 */
export async function openingReadiness(ctx: ActorContext): Promise<OpeningReadiness> {
  requirePermission(ctx, 'reports:financial')

  const [equity, reported, receivableDetail, payableDetail] = await Promise.all([
    controlBalance(ctx, SYSTEM_ACCOUNTS.openingBalanceEquity),

    // The most recent trial balance that is still in effect. A reverted one
    // says nothing about the current books.
    db
      .select({
        receivable: importRuns.receivableControlCents,
        payable: importRuns.payableControlCents,
      })
      .from(importRuns)
      .where(
        scoped(
          ctx,
          importRuns,
          eq(importRuns.kind, 'trial_balance'),
          eq(importRuns.status, 'committed'),
        ),
      )
      .orderBy(desc(importRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),

    db
      .select({ total: sql<string>`COALESCE(SUM(${invoices.balanceCents}), 0)` })
      .from(invoices)
      .where(scoped(ctx, invoices, sql`${invoices.status} <> 'void'`))
      .then((rows) => Number(rows[0]?.total ?? 0)),
    db
      .select({ total: sql<string>`COALESCE(SUM(${bills.balanceCents}), 0)` })
      .from(bills)
      .where(scoped(ctx, bills, sql`${bills.status} <> 'void'`))
      .then((rows) => Number(rows[0]?.total ?? 0)),
  ])

  const receivablesReportedCents = reported?.receivable ?? null
  const payablesReportedCents = reported?.payable ?? null

  // No trial balance means nothing to check the detail against, which is not
  // a disagreement — it is an unanswered question, and saying "they agree"
  // would be a claim nobody made.
  const receivablesAgree =
    receivablesReportedCents === null || receivablesReportedCents === receivableDetail
  const payablesAgree = payablesReportedCents === null || payablesReportedCents === payableDetail

  return {
    openingBalanceEquityCents: equity,
    isClear: equity === 0,
    receivablesReportedCents,
    receivablesDetailCents: receivableDetail,
    receivablesAgree,
    payablesReportedCents,
    payablesDetailCents: payableDetail,
    payablesAgree,
    diagnosis: diagnose(equity, {
      migrated: reported !== null,
      receivablesAgree,
      receivableGap: (receivablesReportedCents ?? 0) - receivableDetail,
      payablesAgree,
      payableGap: (payablesReportedCents ?? 0) - payableDetail,
    }),
  }
}

function diagnose(
  equityCents: number,
  detail: {
    migrated: boolean
    receivablesAgree: boolean
    receivableGap: number
    payablesAgree: boolean
    payableGap: number
  },
): string {
  // A company that never migrated has a zero here because nothing was ever
  // posted to it, not because a migration reconciled. Congratulating them on
  // a complete opening position would be telling them something they never
  // claimed and cannot rely on.
  if (!detail.migrated) {
    return equityCents === 0
      ? 'No opening balances have been imported. These books start from zero, which is right for a business that has not traded before — and wrong for one that has.'
      : `Opening Balance Equity carries ${formatPlain(Math.abs(equityCents))} from something other than an import, since no trial balance has been brought across.`
  }

  if (equityCents === 0) {
    return 'Opening Balance Equity is zero. The opening position is complete and consistent.'
  }

  const parts: string[] = []

  if (!detail.receivablesAgree) {
    parts.push(
      `the customer detail is ${formatPlain(Math.abs(detail.receivableGap))} ` +
        `${detail.receivableGap > 0 ? 'less than' : 'more than'} the receivables balance the ` +
        'trial balance reported',
    )
  }
  if (!detail.payablesAgree) {
    parts.push(
      `the vendor detail is ${formatPlain(Math.abs(detail.payableGap))} ` +
        `${detail.payableGap > 0 ? 'less than' : 'more than'} the payables balance the trial ` +
        'balance reported',
    )
  }

  if (parts.length === 0) {
    return (
      `Opening Balance Equity carries ${formatPlain(Math.abs(equityCents))}. The receivable and ` +
      'payable detail both agree with their control accounts, so the difference is elsewhere — ' +
      'most often an opening balance for an account whose detail has not been brought across ' +
      'yet, such as inventory or fixed assets.'
    )
  }

  return (
    `Opening Balance Equity carries ${formatPlain(Math.abs(equityCents))} because ` +
    `${parts.join(', and ')}.`
  )
}

/** Debit-normal balance of one account by number, from posted lines. */
async function controlBalance(ctx: ActorContext, number: string): Promise<number> {
  const [row] = await db
    .select({
      debit: sql<string>`COALESCE(SUM(${journalLines.debitCents}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalLines.creditCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(chartAccounts.number, number),
      ),
    )

  return (Number(row?.debit ?? 0) - Number(row?.credit ?? 0)) || 0
}

function formatPlain(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
