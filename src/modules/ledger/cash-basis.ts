import { and, eq, gte, inArray, isNotNull, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import {
  chartAccounts,
  invoiceWriteOffs,
  invoices,
  journalEntries,
  journalLines,
  paymentApplications,
  payments,
} from '@/db/schema'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { INDUSTRY_ACCOUNTS, SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { cashFlowClass, isAccrualOnly, isCashAccount } from '@/modules/coa/classification'
import { formatCents } from '@/lib/money'
import { normalBalance, type AccountBalance } from './balances'
import type { AccountType } from '@/modules/coa/standard'

/**
 * Cash-basis reporting (spec §13: "cash and accrual reporting modes where
 * supported by the underlying transaction model").
 *
 * ## Why this was deferred, and what changed
 *
 * ADR 0002 left it out on purpose:
 *
 * > Doing cash basis correctly means looking through payment applications to
 * > the revenue and expense accounts on the documents they settle, which the
 * > `payment_applications` table was designed to make possible. It is
 * > deliberate scope left for Phase 2b rather than an approximation shipped as
 * > if it were the real thing.
 *
 * Nothing about the difficulty changed. What changed is that Phase 9 built tax
 * workpapers, and most small businesses file on a cash basis — so an
 * accrual-only workpaper pack is half a tool for exactly the people it was for.
 *
 * ## The approximation this is not
 *
 * The tempting shortcut is to report the bank accounts' movements and call it
 * cash basis. It is wrong in a way that looks right: every receipt lands on one
 * line, so the report shows a single enormous "customer receipts" figure rather
 * than revenue split across the accounts the invoices were raised against.
 * Nobody can file from that.
 *
 * ## The transformation
 *
 * Cash basis is the accrual ledger with two edits, and it is easier to reason
 * about as a rewrite of entries than as a formula over balances:
 *
 * ```
 *   accrual                          cash
 *   ────────────────────────────     ────────────────────────────
 *   Invoice:  Dr AR      1080        (nothing — no document entry)
 *             Cr Revenue 1000
 *             Cr Tax        80
 *
 *   Payment:  Dr Bank    1080        Dr Bank    1080
 *             Cr AR      1080        Cr Revenue 1000
 *                                    Cr Tax        80
 * ```
 *
 * So:
 *
 *  1. **Remove every line of every invoice and bill entry.** Not just the
 *     revenue leg — the whole entry, so the receivable it created goes too.
 *  2. **Remove the receivable/payable leg of each payment entry**, and put the
 *     settled document's other legs in its place, pro-rated by how much of the
 *     document this payment covered.
 *
 * Everything else is left alone, and that is the quiet half of the design: a
 * categorized bank transaction, a payroll run, a manual entry, a remittance —
 * all of them already hit an expense and the bank in one entry, so they are
 * cash basis already and need no adjustment.
 *
 * ## Why it still balances
 *
 * Removing a whole entry preserves balance trivially. The second edit does too,
 * and provably: the document's non-control legs sum to exactly the amount that
 * hit its control account, so pro-rating them by *this payment's* share yields
 * exactly the payment amount being removed. Take away a credit of X, add
 * credits totalling X. `tests/cash-basis.test.ts` asserts the balance sheet
 * balances on both bases rather than trusting the argument.
 *
 * ## Rounding is settled once, on the last line
 *
 * A part-paid invoice recognizes part of each of its lines in proportion.
 * Integer division does not distribute, so shares are computed with a running
 * remainder and **the last line absorbs the difference**. Rounding each line
 * independently loses cents, and a cash-basis P&L that does not foot to the
 * cash actually received is one somebody has to reconcile by hand — the thing
 * this exists to avoid.
 */

export type ReportingBasis = 'accrual' | 'cash'

export const BASIS_LABELS: Record<ReportingBasis, string> = {
  accrual: 'Accrual',
  cash: 'Cash',
}

export const BASIS_DESCRIPTIONS: Record<ReportingBasis, string> = {
  accrual:
    'Revenue when it is earned and expenses when they are incurred, whether or not money has moved.',
  cash: 'Revenue when the money arrives and expenses when it leaves. What most small businesses file on.',
}

export function isReportingBasis(value: unknown): value is ReportingBasis {
  return value === 'accrual' || value === 'cash'
}

/**
 * The accounts whose whole purpose is to hold an amount until it is paid.
 *
 * Cash basis is the claim that these do not exist, so they are what gets
 * removed and what a payment's leg is replaced against.
 *
 * **Retainage is deliberately not here**, and it was on the first attempt.
 * Including it looked right — retainage is a receivable under another name —
 * but a retainage-release invoice has *only* control legs (Dr Receivable,
 * Cr Retainage Receivable), so there was nothing left to recognize against and
 * the payment's leg was removed with nothing put back. The books stopped
 * balancing on exactly one kind of company. See `scaleSigned` for what makes
 * the replacement balance for any document shape instead.
 */
const CONTROL_ACCOUNT_NUMBERS: string[] = [
  SYSTEM_ACCOUNTS.accountsReceivable,
  SYSTEM_ACCOUNTS.accountsPayable,
]

/** A basket of income-statement legs, keyed by account, with its signed net. */
type Basket = { entries: Array<[string, number]>; net: number }

export type AccrualPlan = {
  /** Recognition entries: the accrual claim itself, which cash basis rejects. */
  removedEntryIds: Set<string>
  /**
   * Cash entries whose accrual-only legs are replaced.
   *
   * Keyed by entry, then by the accrual-only account, because one entry can
   * settle two different accruals and each takes its own basket.
   */
  replacedLegs: Map<string, Map<string, Basket>>
  /**
   * Entries touching an accrual-only account that neither rule could handle —
   * a reclass between two balance-sheet accounts, or a settlement made before
   * anything said what the accrual was for. Left untouched, and reported by
   * `cashBasisCaveats` so the report says where it is approximate.
   */
  unresolvedCents: number
}

/**
 * Works out what to do with every entry that touches an accrual-only account.
 *
 * ## The two shapes
 *
 * Every timing difference is written down twice — once when the cash moves and
 * once when the amount is recognized — and cash basis keeps the first and
 * discards the second. Which entry is which is not a matter of dates or signs;
 * it is visible in what the entry's *other* legs are:
 *
 * ```
 *   Accrued expense                     Prepayment
 *   ─────────────────────────────       ─────────────────────────────
 *   Dr  Rent          5000   ← recog.   Dr  Prepaid      12000  ← cash
 *       Cr  Accrued   5000                  Cr  Bank     12000
 *
 *   Dr  Accrued       5000   ← cash     Dr  Rent          1000  ← recog.
 *       Cr  Bank      5000                  Cr  Prepaid   1000
 * ```
 *
 * The recognition entry's other legs are income-statement accounts; the cash
 * entry's include cash. So the rule is: **remove the recognition entry and
 * keep what it said the money was for; then, on the cash entry, put that back
 * in place of the accrual-only leg.**
 *
 * Deferred revenue is the same machinery upside down — a deposit is the cash
 * entry, and earning it later is the recognition — and it comes out right
 * without a special case, because the basket carries its own direction.
 *
 * ## Why the whole ledger, and not the window
 *
 * A prepayment made in one period is recognized in another. The basket has to
 * be assembled from every recognition entry there has ever been, or a report
 * whose window happens to exclude the amortizations would silently drop them.
 * Only entries touching an accrual-only account are read, which on a typical
 * set of books is a small fraction of the journal.
 *
 * ## What this does not attempt
 *
 * Recognition entries are pooled per account rather than matched to a specific
 * prepayment. A company running two prepaid insurance policies through one
 * account gets the pool, not the policy. Doing better needs the accrual and
 * its settlement linked the way `payment_applications` links a payment to its
 * invoice, and that link does not exist for something typed as a journal
 * entry — which is exactly why receivables and payables are *not* handled by
 * this code path.
 */
async function accrualPlan(
  ctx: ActorContext,
  sets: {
    accrualAccountIds: Set<string>
    cashAccountIds: Set<string>
    incomeAccountIds: Set<string>
  },
): Promise<AccrualPlan> {
  const empty: AccrualPlan = {
    removedEntryIds: new Set(),
    replacedLegs: new Map(),
    unresolvedCents: 0,
  }

  if (sets.accrualAccountIds.size === 0) return empty

  const accrualIds = [...sets.accrualAccountIds]

  // Every line of every entry that touches an accrual-only account, whenever
  // it was posted. The inner select finds the entries; the outer one takes
  // all their lines, because the decision needs the legs on the other side.
  const rows = await db
    .select({
      journalEntryId: journalLines.journalEntryId,
      chartAccountId: journalLines.chartAccountId,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
      source: journalEntries.source,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        // Invoices, bills, and payments already have an exact path through
        // payment applications. Running them through inference as well would
        // transform the same amount twice.
        sql`${journalEntries.source} NOT IN ('invoice', 'bill', 'payment')`,
        sql`${journalLines.journalEntryId} IN (
          SELECT ${journalLines.journalEntryId} FROM ${journalLines}
          WHERE ${journalLines.companyId} = ${ctx.companyId}
            AND ${inArray(journalLines.chartAccountId, accrualIds)}
        )`,
      ),
    )

  const byEntry = new Map<string, typeof rows>()
  for (const row of rows) {
    const existing = byEntry.get(row.journalEntryId) ?? []
    existing.push(row)
    byEntry.set(row.journalEntryId, existing)
  }

  const plan: AccrualPlan = {
    removedEntryIds: new Set(),
    replacedLegs: new Map(),
    unresolvedCents: 0,
  }

  // Per accrual-only account, what the recognition entries said the money was
  // for. Signed, so a reversal cancels the accrual it reverses.
  const baskets = new Map<string, Map<string, number>>()
  const cashEntries: Array<{ entryId: string; legs: Map<string, number> }> = []

  for (const [entryId, lines] of byEntry) {
    const accrualLegs = lines.filter((line) => sets.accrualAccountIds.has(line.chartAccountId))
    const otherLegs = lines.filter((line) => !sets.accrualAccountIds.has(line.chartAccountId))

    if (accrualLegs.length === 0 || otherLegs.length === 0) continue

    const touchesCash = otherLegs.some((line) => sets.cashAccountIds.has(line.chartAccountId))
    const allIncome = otherLegs.every((line) => sets.incomeAccountIds.has(line.chartAccountId))

    if (!touchesCash && allIncome) {
      plan.removedEntryIds.add(entryId)

      // The whole entry's income legs go into the basket of whichever accrual
      // account it moved. Split across accounts when it moved more than one,
      // by the size of each accrual leg.
      const accrualNet = accrualLegs.reduce(
        (sum, line) => sum + line.debitCents - line.creditCents,
        0,
      )
      if (accrualNet === 0) continue

      for (const accrualLeg of accrualLegs) {
        const legNet = accrualLeg.debitCents - accrualLeg.creditCents
        const basket = baskets.get(accrualLeg.chartAccountId) ?? new Map<string, number>()

        for (const income of otherLegs) {
          const incomeNet = income.debitCents - income.creditCents
          const share = Math.round((incomeNet * legNet) / accrualNet)
          basket.set(income.chartAccountId, (basket.get(income.chartAccountId) ?? 0) + share)
        }

        baskets.set(accrualLeg.chartAccountId, basket)
      }
      continue
    }

    if (touchesCash) {
      const legs = new Map<string, number>()
      for (const accrualLeg of accrualLegs) {
        legs.set(
          accrualLeg.chartAccountId,
          (legs.get(accrualLeg.chartAccountId) ?? 0) +
            accrualLeg.debitCents -
            accrualLeg.creditCents,
        )
      }
      cashEntries.push({ entryId, legs })
      continue
    }

    // Neither shape: a reclass between two balance-sheet accounts, or an
    // accrual settled against something that is not cash and not income.
    plan.unresolvedCents += accrualLegs.reduce(
      (sum, line) => sum + Math.abs(line.debitCents - line.creditCents),
      0,
    )
  }

  for (const cashEntry of cashEntries) {
    const perAccount = new Map<string, Basket>()

    for (const [accrualAccountId, legNet] of cashEntry.legs) {
      const basket = baskets.get(accrualAccountId)
      const entries = basket ? [...basket.entries()].filter(([, signed]) => signed !== 0) : []
      const net = entries.reduce((sum, [, signed]) => sum + signed, 0)

      if (net === 0) {
        // Nothing has said what this money was for yet — a prepayment made and
        // not amortized, or an accrual settled before it was accrued. The leg
        // stays where it is, which puts the accrual-only account on a cash
        // balance sheet. That is the honest answer and it is reported as one.
        plan.unresolvedCents += Math.abs(legNet)
        continue
      }

      perAccount.set(accrualAccountId, { entries, net })
    }

    if (perAccount.size > 0) plan.replacedLegs.set(cashEntry.entryId, perAccount)
  }

  return plan
}

/**
 * Splits an amount across weights, preserving the total exactly.
 *
 * Pure, and its own function because it is the one piece of arithmetic here
 * that is easy to get subtly wrong and cheap to test exhaustively. The last
 * weight takes what is left rather than its own rounded share, so the parts
 * always sum to the whole.
 */
export function prorate(amountCents: number, weights: number[]): number[] {
  if (weights.length === 0) return []

  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total === 0) return weights.map(() => 0)

  const shares: number[] = []
  let allocated = 0

  for (let index = 0; index < weights.length - 1; index++) {
    const share = Math.round((amountCents * weights[index]) / total)
    shares.push(share)
    allocated += share
  }

  shares.push(amountCents - allocated)
  return shares
}

/**
 * Scales a document's legs so they net to exactly `amountCents`, keeping each
 * leg's own side.
 *
 * This is what makes the replacement balanced **for any document shape**, and
 * the first version of this file got it wrong by pro-rating unsigned amounts.
 * A progress billing splits its debit across Accounts Receivable and Retainage
 * Receivable while crediting the full contract revenue, so its legs do not all
 * sit on one side — adding up magnitudes there produces shares that are the
 * right size and the wrong direction.
 *
 * Working in signed cents instead: each leg is `debit − credit`, the set is
 * scaled to the target net, and the last leg absorbs the rounding so the parts
 * still sum to the whole.
 */
export function scaleSigned(targetNetCents: number, signed: number[]): number[] {
  if (signed.length === 0) return []

  const total = signed.reduce((sum, value) => sum + value, 0)
  if (total === 0) return signed.map(() => 0)

  const shares: number[] = []
  let allocated = 0

  for (let index = 0; index < signed.length - 1; index++) {
    const share = Math.round((targetNetCents * signed[index]) / total)
    shares.push(share)
    allocated += share
  }

  shares.push(targetNetCents - allocated)
  return shares
}

type Delta = { debitCents: number; creditCents: number }

function add(deltas: Map<string, Delta>, accountId: string, debit: number, credit: number): void {
  const current = deltas.get(accountId) ?? { debitCents: 0, creditCents: 0 }
  current.debitCents += debit
  current.creditCents += credit
  deltas.set(accountId, current)
}

/**
 * Account balances on a cash basis.
 *
 * Returns the same shape as `accountBalances`, so every report that consumes
 * it takes a basis and needs no other change.
 */
export async function cashBasisBalances(
  ctx: ActorContext,
  range: { startDate?: string; endDate?: string } = {},
): Promise<AccountBalance[]> {
  requirePermission(ctx, 'reports:financial')

  const window = [
    range.startDate ? gte(journalEntries.entryDate, range.startDate) : undefined,
    range.endDate ? lte(journalEntries.entryDate, range.endDate) : undefined,
  ].filter(Boolean) as SQL[]

  const [accounts, allLines, documentLines] = await Promise.all([
    db
      .select({
        id: chartAccounts.id,
        number: chartAccounts.number,
        name: chartAccounts.name,
        type: chartAccounts.type,
        subtype: chartAccounts.subtype,
      })
      .from(chartAccounts)
      .where(eq(chartAccounts.companyId, ctx.companyId)),

    // Every posted line in the window, with the entry's source and origin so
    // the two edits below can find what they need without a second pass.
    db
      .select({
        journalEntryId: journalLines.journalEntryId,
        chartAccountId: journalLines.chartAccountId,
        debitCents: journalLines.debitCents,
        creditCents: journalLines.creditCents,
        source: journalEntries.source,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          ...window,
        ),
      ),

    // Every line of every invoice and bill entry, whenever it was raised — a
    // payment in this period may settle a document from the last one.
    db
      .select({
        documentId: journalEntries.sourceId,
        chartAccountId: journalLines.chartAccountId,
        debitCents: journalLines.debitCents,
        creditCents: journalLines.creditCents,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          inArray(journalEntries.source, ['invoice', 'bill']),
        ),
      ),
  ])

  const controlAccountIds = new Set(
    accounts.filter((a) => CONTROL_ACCOUNT_NUMBERS.includes(a.number)).map((a) => a.id),
  )

  const accrualAccountIds = new Set(
    accounts.filter((a) => isAccrualOnly(a.type as AccountType, a.subtype)).map((a) => a.id),
  )
  const cashAccountIds = new Set(
    accounts.filter((a) => isCashAccount(a.type as AccountType, a.subtype)).map((a) => a.id),
  )
  const incomeAccountIds = new Set(
    accounts.filter((a) => cashFlowClass(a.type as AccountType, a.subtype) === 'income').map((a) => a.id),
  )

  const accrual = await accrualPlan(ctx, {
    accrualAccountIds,
    cashAccountIds,
    incomeAccountIds,
  })

  const deltas = new Map<string, Delta>()

  // --- Edit 1: everything except invoice and bill entries -------------------
  for (const line of allLines) {
    if (line.source === 'invoice' || line.source === 'bill') continue

    // --- Edit 3: accruals and prepayments ---------------------------------
    // A recognition entry moved an amount into the period it was earned or
    // incurred in. That is the accrual claim itself, so on a cash basis the
    // entry never happened.
    if (accrual.removedEntryIds.has(line.journalEntryId)) continue

    // On a cash entry, the accrual-only leg is replaced below by whatever the
    // recognition entries said the money was for.
    if (
      accrual.replacedLegs.has(line.journalEntryId) &&
      accrualAccountIds.has(line.chartAccountId)
    ) {
      continue
    }

    // A bad debt is a non-event on a cash basis. The revenue was never taken
    // into account, so there is nothing to write off — which is also why a
    // cash-basis taxpayer cannot deduct one. Keeping the entry would leave its
    // credit to Receivables stranded on a statement that has no receivables.
    if (line.sourceType === 'invoice_write_off') continue

    // A recovery's cash leg stays; its Bad Debt leg is replaced below by the
    // original invoice's revenue, because on a cash basis money arriving
    // against that invoice *is* the revenue.
    if (line.sourceType === 'write_off_recovery' && !isBankish(line, controlAccountIds)) continue

    // A payment's control leg is replaced below, not kept.
    if (line.source === 'payment' && controlAccountIds.has(line.chartAccountId)) continue

    add(deltas, line.chartAccountId, line.debitCents, line.creditCents)
  }

  // --- Edit 2: the settled documents' own legs, pro-rated -------------------
  const linesByDocument = new Map<string, typeof documentLines>()
  for (const line of documentLines) {
    if (!line.documentId) continue
    const existing = linesByDocument.get(line.documentId) ?? []
    existing.push(line)
    linesByDocument.set(line.documentId, existing)
  }

  /**
   * Dated by when the application happened, not when the money arrived
   * (Phase 113).
   *
   * This module recognises through the document a payment settles — its own
   * caveat below says so — so the period an application belongs to is the
   * period it was made in. Held credit spent months later is the case where
   * the two dates differ, and until `payment_applications` had a date of its
   * own the only one available was `payments.payment_date`. A March
   * overpayment applied to a July invoice was reported as March revenue, and
   * re-running March afterwards returned more than it had before — a closed
   * period changing because of something somebody did today.
   */
  const applications = await db
    .select({
      amountCents: paymentApplications.amountCents,
      invoiceId: paymentApplications.invoiceId,
      billId: paymentApplications.billId,
    })
    .from(paymentApplications)
    .innerJoin(payments, eq(payments.id, paymentApplications.paymentId))
    .where(
      and(
        eq(paymentApplications.companyId, ctx.companyId),
        // A voided payment never happened (Phase 52). Leaving it in would
        // report revenue on a cash basis that was never received — the single
        // worst place for a void to be forgotten.
        eq(payments.status, 'posted'),
        ...([
          range.startDate ? gte(paymentApplications.appliedOn, range.startDate) : undefined,
          range.endDate ? lte(paymentApplications.appliedOn, range.endDate) : undefined,
        ].filter(Boolean) as SQL[]),
      ),
    )

  // A recovered write-off is money arriving against an invoice, which is
  // exactly what an application is — so it goes through the same machinery
  // rather than a second path that would need its own rounding rules.
  const recoveryRows = await db
    .select({
      amountCents: invoiceWriteOffs.recoveredCents,
      invoiceId: invoiceWriteOffs.invoiceId,
    })
    .from(invoiceWriteOffs)
    .where(
      and(
        eq(invoiceWriteOffs.companyId, ctx.companyId),
        isNotNull(invoiceWriteOffs.recoveredOn),
        ...([
          range.startDate ? gte(invoiceWriteOffs.recoveredOn, range.startDate) : undefined,
          range.endDate ? lte(invoiceWriteOffs.recoveredOn, range.endDate) : undefined,
        ].filter(Boolean) as SQL[]),
      ),
    )

  const recoveries = recoveryRows
    .filter((row) => row.amountCents !== null)
    .map((row) => ({
      amountCents: row.amountCents as number,
      invoiceId: row.invoiceId,
      billId: null as string | null,
    }))

  for (const application of [...applications, ...recoveries]) {
    const documentId = application.invoiceId ?? application.billId
    if (!documentId) continue

    const lines = linesByDocument.get(documentId)
    if (!lines) continue

    const recognized = lines.filter((line) => !controlAccountIds.has(line.chartAccountId))
    if (recognized.length === 0) continue

    // What the payment removed from the control account, signed. Scaling the
    // document's other legs to exactly offset it is what keeps the books
    // balanced whatever shape the document had.
    const controlNet = lines
      .filter((line) => controlAccountIds.has(line.chartAccountId))
      .reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)

    if (controlNet === 0) continue

    // A receipt credits Receivables; the replacement must credit the same
    // amount. The sign follows the control leg it is standing in for.
    const targetNet = controlNet > 0 ? -application.amountCents : application.amountCents

    const shares = scaleSigned(
      targetNet,
      recognized.map((line) => line.debitCents - line.creditCents),
    )

    recognized.forEach((line, index) => {
      const share = shares[index]
      if (share === 0) return
      if (share > 0) add(deltas, line.chartAccountId, share, 0)
      else add(deltas, line.chartAccountId, 0, -share)
    })
  }

  // --- Edit 3, second half: what the accrual-only legs are replaced with ----
  for (const line of allLines) {
    const replacement = accrual.replacedLegs.get(line.journalEntryId)
    if (!replacement) continue
    if (!accrualAccountIds.has(line.chartAccountId)) continue

    const legNet = line.debitCents - line.creditCents
    const basket = replacement.get(line.chartAccountId)
    if (!basket || basket.net === 0) continue

    // Scale the basket to exactly what this leg was worth, so the amount put
    // back equals the amount taken out and the entry still balances.
    const shares = scaleSigned(
      legNet,
      basket.entries.map(([, signed]) => signed),
    )

    basket.entries.forEach(([accountId], index) => {
      const share = shares[index]
      if (share === 0) return
      if (share > 0) add(deltas, accountId, share, 0)
      else add(deltas, accountId, 0, -share)
    })
  }

  return accounts
    .map((account) => {
      const delta = deltas.get(account.id) ?? { debitCents: 0, creditCents: 0 }
      const type = account.type as AccountType

      return {
        chartAccountId: account.id,
        number: account.number,
        name: account.name,
        type,
        subtype: account.subtype,
        debitCents: delta.debitCents,
        creditCents: delta.creditCents,
        balanceCents: normalBalance(type, delta.debitCents, delta.creditCents),
      }
    })
    .filter((row) => row.debitCents !== 0 || row.creditCents !== 0)
    .sort((a, b) => a.number.localeCompare(b.number))
}

/**
 * Balances on whichever basis was asked for.
 *
 * The single seam every report goes through, so adding a basis was one argument
 * threaded down rather than a parallel set of report functions that would drift
 * apart the first time one of them was fixed.
 */
export async function balancesForBasis(
  ctx: ActorContext,
  basis: ReportingBasis,
  range: { startDate?: string; endDate?: string } = {},
): Promise<AccountBalance[]> {
  if (basis === 'cash') return cashBasisBalances(ctx, range)

  const { accountBalances } = await import('./balances')
  return accountBalances(ctx, range)
}

/**
 * What a cash-basis report of *this company's* books cannot represent.
 *
 * Every real cash-basis report carries caveats, and the difference between a
 * usable one and a misleading one is whether they are printed on it. These are
 * computed from the data rather than being boilerplate — a company with no
 * payroll is not warned about payroll.
 */
export type BasisCaveat = { area: string; message: string }

export async function cashBasisCaveats(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<BasisCaveat[]> {
  requirePermission(ctx, 'reports:financial')

  const caveats: BasisCaveat[] = []

  const [payrollRows, unappliedRows, taxRows] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${journalLines.debitCents}), 0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          eq(journalEntries.source, 'payroll'),
          gte(journalEntries.entryDate, range.startDate),
          lte(journalEntries.entryDate, range.endDate),
        ),
      ),

    db
      .select({
        count: sql<string>`count(*)`,
        total: sql<string>`coalesce(sum(${payments.amountCents}), 0)`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.companyId, ctx.companyId),
          eq(payments.status, 'posted'),
          gte(payments.paymentDate, range.startDate),
          lte(payments.paymentDate, range.endDate),
          sql`NOT EXISTS (
            SELECT 1 FROM ${paymentApplications}
            WHERE ${paymentApplications.paymentId} = ${payments.id}
          )`,
        ),
      ),

    db
      .select({ total: sql<string>`coalesce(sum(${invoices.taxCents}), 0)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          gte(invoices.issueDate, range.startDate),
          lte(invoices.issueDate, range.endDate),
        ),
      ),
  ])

  if (Number(payrollRows[0]?.total ?? 0) > 0) {
    caveats.push({
      area: 'Payroll',
      message:
        'Wage cost is recognized when the run is posted, not when people are actually paid. ' +
        'Where a pay date falls in the following period, the cost sits in the earlier one here.',
    })
  }

  if (Number(unappliedRows[0]?.count ?? 0) > 0) {
    caveats.push({
      area: 'Unapplied payments',
      message:
        `${unappliedRows[0].count} payment(s) in this period are applied to no invoice or bill. ` +
        'Cash basis recognizes through the document a payment settles, so these move the bank ' +
        'balance and appear in no revenue or expense account.',
    })
  }

  if (Number(taxRows[0]?.total ?? 0) > 0) {
    caveats.push({
      area: 'Sales tax',
      message:
        'Sales tax collected is a liability on both bases and revenue on neither. It is excluded ' +
        'from the figures here, which is why cash received exceeds cash-basis revenue.',
    })
  }

  // Accruals and prepayments the transformation could not resolve. Computed
  // by running the plan rather than by a heuristic, so the figure printed is
  // the amount that actually stayed put.
  const accounts = await db
    .select({
      id: chartAccounts.id,
      type: chartAccounts.type,
      subtype: chartAccounts.subtype,
    })
    .from(chartAccounts)
    .where(eq(chartAccounts.companyId, ctx.companyId))

  const plan = await accrualPlan(ctx, {
    accrualAccountIds: new Set(
      accounts.filter((a) => isAccrualOnly(a.type as AccountType, a.subtype)).map((a) => a.id),
    ),
    cashAccountIds: new Set(
      accounts.filter((a) => isCashAccount(a.type as AccountType, a.subtype)).map((a) => a.id),
    ),
    incomeAccountIds: new Set(
      accounts
        .filter((a) => cashFlowClass(a.type as AccountType, a.subtype) === 'income')
        .map((a) => a.id),
    ),
  })

  if (plan.unresolvedCents > 0) {
    caveats.push({
      area: 'Accruals and prepayments',
      message:
        `${formatCents(plan.unresolvedCents)} sits in accrual accounts that nothing has yet said ` +
        'what it was for — a prepayment not amortized, or an accrual settled before it was ' +
        'recorded. Those amounts stay on the balance sheet instead of becoming income or expense.',
    })
  }

  return caveats
}

/**
 * Whether a line is the cash side of a recovery rather than its Bad Debt side.
 *
 * A recovery is `Dr Bank / Cr Bad Debt`. The bank leg is real cash and stays;
 * the expense leg is replaced by the original invoice's revenue.
 */
function isBankish(
  line: { chartAccountId: string; debitCents: number },
  controlAccountIds: Set<string>,
): boolean {
  return line.debitCents > 0 && !controlAccountIds.has(line.chartAccountId)
}
