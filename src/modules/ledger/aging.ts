/**
 * How collectable is what we are owed, by age (spec §13, §35).
 *
 * ## The defect
 *
 * `arAging` selected `invoices.balance_cents` — the amount in the currency the
 * **customer** was invoiced in — and added those together into buckets and a
 * total. `apAging` did the same over bills.
 *
 * Phase 61 found exactly this in the statement, and wrote it down:
 *
 * > A customer invoiced €4,000 and $1,200 was told they owed **$5,200.00**: a
 * > number in no currency at all, with a dollar sign on it. **The aging buckets
 * > added the same way**, and Phase 54's net-position sentence restated the same
 * > figure.
 *
 * It fixed the statement's own buckets and left the standalone report. Measured
 * on the development books rather than reasoned about: Bremen Hafenbau GmbH is
 * invoiced €2,500.00, worth $2,708.75, and the aging report renders their row
 * through `formatCents` with no currency — **`$2,500.00`**. The report total was
 * `$49,791.94` where the receivables control account said `$49,400.69`.
 *
 * Nineteen other modules read `functional_balance_cents` for precisely this
 * reason. This file is the twentieth, arriving late.
 *
 * ## Why aging is not a statement, and takes the opposite answer
 *
 * Phase 61 concluded that **a statement states a balance per currency**, because
 * a statement is addressed to one customer and asks them to pay: the only honest
 * figure is the one in the currency they were invoiced in.
 *
 * An aging report is the other kind of document. It is internal, it spans every
 * customer, and it answers one question — *how much of what we are owed is going
 * bad* — which has an answer in exactly one currency: **the company's own**. A
 * report split per currency could not be summed, sorted, or compared against the
 * balance sheet, which is most of what it is for.
 *
 * So aging takes the *functional* figure, and the argument for the two opposite
 * answers is the same argument: a total only means something when its terms are
 * in one currency, and which currency depends on who is being asked to act.
 *
 * ## The trap that fixing the arithmetic would otherwise set
 *
 * Once Bremen's row reads `$2,708.75`, somebody reading it can ring Bremen and
 * ask for $2,708.75 — which is not what Bremen owes, and not a number Bremen
 * has ever seen. So a row whose documents were not all in the home currency
 * carries what it was actually invoiced, and `foreignNote` says it in words.
 *
 * No database and no clock: this file decides, `reports.ts` fetches.
 */

import { formatCents } from '@/lib/money'

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'

/** In order, with what a person reads at the top of the column. */
export const BUCKETS: ReadonlyArray<{ key: AgingBucket; label: string }> = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30' },
  { key: 'd31_60', label: '31–60' },
  { key: 'd61_90', label: '61–90' },
  { key: 'd90_plus', label: '90+' },
]

/** Which bucket an unpaid document falls into, by days past due. */
export function agingBucket(dueDate: string, asOfDate: string): AgingBucket {
  const due = Date.parse(`${dueDate}T00:00:00Z`)
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`)
  const daysPastDue = Math.floor((asOf - due) / 86_400_000)

  if (daysPastDue <= 0) return 'current'
  if (daysPastDue <= 30) return 'd1_30'
  if (daysPastDue <= 60) return 'd31_60'
  if (daysPastDue <= 90) return 'd61_90'
  return 'd90_plus'
}

/** One open document, as the database hands it over. */
export type AgeableDocument = {
  partyId: string
  partyName: string
  dueDate: string
  /** The currency the other party was invoiced in. */
  currency: string
  /** In `currency` — what the other party owes. Never aged, only quoted. */
  balanceCents: number
  /** What that is worth in the company's own money. The figure that ages. */
  functionalBalanceCents: number
}

/** What one party was invoiced, in a currency that is not the company's own. */
export type ForeignBalance = { currency: string; balanceCents: number }

export type Buckets = Record<AgingBucket, number> & { totalCents: number }

export type AgingRow = Buckets & {
  partyId: string
  partyName: string
  /**
   * What they were invoiced, where that was not the home currency.
   *
   * Empty for the overwhelming majority of rows, and then nothing about the
   * report changes. Present so that nobody quotes the home-currency figure at
   * somebody who was never billed it.
   */
  foreign: ForeignBalance[]
}

/**
 * A credit issued and not yet applied to any invoice (Phase 106).
 *
 * Deliberately **not** aged and **not** netted into the buckets. Phase 54
 * settled why: aging is about what is owed *by age*, and an unapplied credit
 * has no age, because nobody has yet decided which invoice it belongs to — that
 * decision is a person's.
 *
 * It is carried beside the total instead, because a credit note posts to the
 * control account the moment it is issued, so without this line the aging total
 * and the balance sheet differ by an amount the report never mentions. ADR 0106
 * left that gap open and named closing it as a separate question; this is it.
 */
export type UnappliedCredits = { count: number; functionalCents: number }

export type AgingReport = {
  asOfDate: string
  /** The one currency every figure in `rows` and `totals` is in. */
  currency: string
  rows: AgingRow[]
  totals: Buckets
  credits: UnappliedCredits
  /**
   * What the control account should read, given this report.
   *
   * `totals.totalCents - credits.functionalCents`. Stated rather than left for
   * a reader to work out, because "these two reports disagree" is the question
   * this line exists to answer.
   */
  controlAccountCents: number
}

const emptyBuckets = (): Buckets => ({
  current: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90_plus: 0,
  totalCents: 0,
})

const NO_CREDITS: UnappliedCredits = { count: 0, functionalCents: 0 }

/**
 * The report, from the open documents behind it.
 *
 * A document with nothing outstanding in the company's own money is skipped —
 * tested on `functionalBalanceCents` rather than `balanceCents`, since that is
 * the figure being aged and a rate could in principle round a trivial foreign
 * balance to nothing.
 */
export function buildAging(
  documents: AgeableDocument[],
  opts: { asOfDate: string; currency: string; credits?: UnappliedCredits },
): AgingReport {
  const byParty = new Map<string, AgingRow>()
  const foreignByParty = new Map<string, Map<string, number>>()
  const totals = emptyBuckets()

  for (const document of documents) {
    if (document.functionalBalanceCents === 0) continue

    let row = byParty.get(document.partyId)
    if (!row) {
      row = {
        partyId: document.partyId,
        partyName: document.partyName,
        ...emptyBuckets(),
        foreign: [],
      }
      byParty.set(document.partyId, row)
    }

    const bucket = agingBucket(document.dueDate, opts.asOfDate)
    row[bucket] += document.functionalBalanceCents
    row.totalCents += document.functionalBalanceCents
    totals[bucket] += document.functionalBalanceCents
    totals.totalCents += document.functionalBalanceCents

    if (document.currency !== opts.currency) {
      const perCurrency = foreignByParty.get(document.partyId) ?? new Map<string, number>()
      perCurrency.set(
        document.currency,
        (perCurrency.get(document.currency) ?? 0) + document.balanceCents,
      )
      foreignByParty.set(document.partyId, perCurrency)
    }
  }

  for (const [partyId, perCurrency] of foreignByParty) {
    const row = byParty.get(partyId)
    if (!row) continue
    row.foreign = [...perCurrency.entries()]
      .map(([currency, balanceCents]) => ({ currency, balanceCents }))
      .sort((a, b) => a.currency.localeCompare(b.currency))
  }

  const credits = opts.credits ?? NO_CREDITS

  return {
    asOfDate: opts.asOfDate,
    currency: opts.currency,
    rows: [...byParty.values()].sort((a, b) => a.partyName.localeCompare(b.partyName)),
    totals,
    credits,
    controlAccountCents: totals.totalCents - credits.functionalCents,
  }
}

/**
 * What a foreign row was actually invoiced.
 *
 * "Invoiced €2,500.00" — so the home-currency figure beside it is read as what
 * it is, a valuation, rather than as a sum to quote at somebody.
 */
export function foreignNote(row: AgingRow): string | undefined {
  if (row.foreign.length === 0) return undefined

  const parts = row.foreign.map((entry) => formatCents(entry.balanceCents, entry.currency))
  return `Invoiced ${parts.join(' and ')}`
}

/**
 * The sentence reconciling this report to the balance sheet.
 *
 * Returned only when there is something to reconcile. A report with no
 * unapplied credits ties exactly, and saying so at length would be noise.
 *
 * Written as **two whole sentences rather than one with the number spliced
 * through it**. Six things here have to agree on the count — the noun, three
 * verbs, a pronoun and "each" — and Phase 105 shipped "1 retainer hold" by
 * pluralising one of two. Browser verification of the first draft of this
 * function produced "1 credit note … They already reduce … which invoice each
 * belongs to", which is the same mistake in a longer sentence. Interleaving
 * ternaries is what makes it possible; branching once is what stops it.
 */
export function creditNote(report: AgingReport): string | undefined {
  if (report.credits.count === 0) return undefined

  const worth = formatCents(report.credits.functionalCents, report.currency)
  const sheet = formatCents(report.controlAccountCents, report.currency)

  if (report.credits.count === 1) {
    return (
      `1 credit note worth ${worth} has been issued and not yet applied to an invoice. ` +
      `It already reduces the control account, so the balance sheet shows ${sheet}; ` +
      'it is not aged here because nobody has decided yet which invoice it belongs to.'
    )
  }

  return (
    `${report.credits.count} credit notes worth ${worth} have been issued and not yet ` +
    'applied to an invoice. They already reduce the control account, so the balance sheet ' +
    `shows ${sheet}; they are not aged here because nobody has decided yet which invoice ` +
    'each belongs to.'
  )
}
