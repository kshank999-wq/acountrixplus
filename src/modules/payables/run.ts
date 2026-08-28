/**
 * What you owe, and choosing what to pay (spec §13, §19).
 *
 * ## What was missing
 *
 * A business could enter a bill and record a payment, and could not answer the
 * question it asks itself every Friday: **what do I owe, what is late, and can
 * I cover it?** The bill list was ordered by issue date with no totals, no
 * overdue marking and no due-date sort; A/P aging existed as a static report
 * with nothing on it clickable.
 *
 * Worse, `recordPaymentAction` has accepted `documentIds` since Phase 41 and
 * honours the order given — and **no screen has ever sent them**. Selection was
 * per *vendor* only, and `allocate` then consumed oldest first. A business
 * paying a supplier's third invoice while disputing the first two could not
 * express it: the money landed on the disputed bills, marking them settled.
 *
 * ## What this module decides
 *
 * How late a bill is, what a chosen set comes to, and whether the bank covers
 * it. It does not decide *what to pay* — that is the business's judgement about
 * which supplier can wait, and no amount of arithmetic replaces it.
 *
 * Nothing here touches the database or the clock. `asOf` is passed in.
 */

/** A bill as this module needs to see it. */
export type PayableBill = {
  id: string
  number: string
  vendorId: string
  vendorName: string
  dueDate: string
  /** What is still outstanding, not the original total. */
  balanceCents: number
}

/**
 * How late something is, in the buckets a person actually thinks in.
 *
 * The same shape as the aging report, because a business looking at "what do I
 * owe" and a business looking at the A/P aging are asking one question and
 * should not have to reconcile two answers.
 */
export type AgeBucket = 'overdue' | 'due_now' | 'due_soon' | 'later'

/** Bills falling due within this many days are worth seeing on a pay run. */
export const SOON_DAYS = 7

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/**
 * Which bucket a bill falls in.
 *
 * `due_now` is exactly today — its own bucket rather than folded into overdue,
 * because a bill due today is not late and telling somebody it is makes them
 * distrust the ones that are.
 */
export function bucketFor(dueDate: string, asOf: string): AgeBucket {
  const days = daysBetween(asOf, dueDate)

  if (days < 0) return 'overdue'
  if (days === 0) return 'due_now'
  if (days <= SOON_DAYS) return 'due_soon'
  return 'later'
}

export type BucketTotals = Record<AgeBucket, { count: number; totalCents: number }>

const EMPTY_BUCKET = { count: 0, totalCents: 0 }

/** What is owed, split by how late it is. */
export function bucketTotals(bills: PayableBill[], asOf: string): BucketTotals {
  const totals: BucketTotals = {
    overdue: { ...EMPTY_BUCKET },
    due_now: { ...EMPTY_BUCKET },
    due_soon: { ...EMPTY_BUCKET },
    later: { ...EMPTY_BUCKET },
  }

  for (const bill of bills) {
    const bucket = totals[bucketFor(bill.dueDate, asOf)]
    bucket.count += 1
    bucket.totalCents += bill.balanceCents
  }

  return totals
}

/**
 * What a chosen set of bills comes to, per supplier.
 *
 * Grouped because that is how the money leaves: **one payment per supplier**,
 * not one per bill. A business paying four of a supplier's invoices writes one
 * cheque, and the bank statement shows one line — the same correspondence
 * Phase 44 needed between a card payout and the deposit it produces, for the
 * same reason: a reconciliation that has four ledger rows against one statement
 * row cannot be done.
 */
export type SupplierRun = {
  vendorId: string
  vendorName: string
  billIds: string[]
  /** In the order chosen, which is the order the payment applies them in. */
  numbers: string[]
  totalCents: number
  /** The oldest due date in the group, for sorting a run sensibly. */
  earliestDue: string
}

export function groupBySupplier(bills: PayableBill[]): SupplierRun[] {
  const groups = new Map<string, SupplierRun>()

  for (const bill of bills) {
    const existing = groups.get(bill.vendorId)

    if (!existing) {
      groups.set(bill.vendorId, {
        vendorId: bill.vendorId,
        vendorName: bill.vendorName,
        billIds: [bill.id],
        numbers: [bill.number],
        totalCents: bill.balanceCents,
        earliestDue: bill.dueDate,
      })
      continue
    }

    existing.billIds.push(bill.id)
    existing.numbers.push(bill.number)
    existing.totalCents += bill.balanceCents
    if (bill.dueDate < existing.earliestDue) existing.earliestDue = bill.dueDate
  }

  return [...groups.values()].sort((a, b) => a.earliestDue.localeCompare(b.earliestDue))
}

export type RunVerdict = {
  suppliers: SupplierRun[]
  totalCents: number
  /** What is left in the account afterwards. Negative means it does not cover. */
  remainingCents: number
  covered: boolean
  /** A sentence, or null when there is nothing worth saying. */
  warning: string | null
}

/**
 * What a pay run costs and whether the account covers it.
 *
 * A shortfall is a **warning, not a refusal**. The balance this compares
 * against is what the ledger knows, which is not what the bank knows — a
 * deposit may have cleared this morning and a cheque written last week may not
 * have. Refusing on that figure would stop a business paying its suppliers
 * because of a timing difference, which is a far worse failure than letting
 * somebody go overdrawn knowingly.
 */
export function planRun(input: {
  chosen: PayableBill[]
  /** What the ledger says is in the account the money is leaving. */
  availableCents: number | null
}): RunVerdict {
  const suppliers = groupBySupplier(input.chosen)
  const totalCents = suppliers.reduce((sum, group) => sum + group.totalCents, 0)

  if (input.availableCents === null) {
    return {
      suppliers,
      totalCents,
      remainingCents: 0,
      covered: true,
      warning: null,
    }
  }

  const remainingCents = input.availableCents - totalCents

  return {
    suppliers,
    totalCents,
    remainingCents,
    covered: remainingCents >= 0,
    warning:
      remainingCents < 0
        ? 'This is more than the account holds, going by the ledger. That figure is not the ' +
          'bank’s — a cheque written last week may not have cleared — so it is worth a look ' +
          'rather than a reason to stop.'
        : null,
  }
}

/**
 * How the chosen bills should be ordered when the payment is applied.
 *
 * Oldest first *within* what somebody chose. The choice is theirs and is
 * respected absolutely — a bill nobody ticked is never touched — but among the
 * ones they did tick, settling the oldest first is what a supplier expects and
 * what keeps an aging report sensible.
 */
export function applicationOrder(bills: PayableBill[]): PayableBill[] {
  return [...bills].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number),
  )
}
