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

/**
 * A bill as this module needs to see it.
 *
 * ## Two amounts, because one number cannot answer two questions (Phase 60)
 *
 * `balanceCents` is what the **supplier** is owed, in the currency they
 * invoiced in. It is what will be paid and what the remittance advice shows,
 * and converting it would be telling a German supplier they are owed dollars.
 *
 * `functionalBalanceCents` is what that is worth in the company's own currency.
 * It is the only figure that may be **added up or compared** — against the bank
 * balance, against an approval threshold, against another supplier's bill.
 *
 * Until Phase 60 this module had only `balanceCents` and used it for both, so
 * "what we owe" added euro to dollars and reported the result with a dollar
 * sign. The same defect [ADR 0056](../../../docs/adr/0056-the-balance-that-added-currencies-together.md)
 * fixed on the customers screen.
 */
export type PayableBill = {
  id: string
  number: string
  vendorId: string
  vendorName: string
  dueDate: string
  /** What is still outstanding, not the original total. */
  balanceCents: number
  /** The currency the supplier invoiced in. */
  currency: string
  /** What `balanceCents` is worth in the company's own currency. */
  functionalBalanceCents: number
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

/**
 * What is owed, split by how late it is.
 *
 * Totalled in the company's own currency: these four figures are sums across
 * whatever suppliers happen to fall in each bucket, and a sum only means
 * something when its terms are in one currency.
 */
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
    bucket.totalCents += bill.functionalBalanceCents
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
  /**
   * What the payment will be for, in the supplier's currency.
   *
   * **Null when the chosen bills span two currencies**, because then there is
   * no such amount. One payment per supplier is how the money leaves, and a
   * single transfer cannot be €4,000 and $4,000 at once — so rather than
   * putting a meaningless sum here for the screen to print, this says there is
   * no answer and `planRun` blocks the supplier.
   */
  totalCents: number | null
  /** The currency of every chosen bill, or null when they disagree. */
  currency: string | null
  /** What the group is worth in the company's currency. Always answerable. */
  functionalTotalCents: number
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
        currency: bill.currency,
        functionalTotalCents: bill.functionalBalanceCents,
        earliestDue: bill.dueDate,
      })
      continue
    }

    existing.billIds.push(bill.id)
    existing.numbers.push(bill.number)
    existing.functionalTotalCents += bill.functionalBalanceCents

    if (existing.currency === bill.currency && existing.totalCents !== null) {
      existing.totalCents += bill.balanceCents
    } else {
      // Once two currencies are in the group there is no supplier-currency
      // total, and there is no going back to having one.
      existing.currency = null
      existing.totalCents = null
    }

    if (bill.dueDate < existing.earliestDue) existing.earliestDue = bill.dueDate
  }

  return [...groups.values()].sort((a, b) => a.earliestDue.localeCompare(b.earliestDue))
}

/**
 * A group that really can be settled by one transfer.
 *
 * The narrowing is the point: everything downstream of `planRun` — the amount
 * on the Pay button, the amount `recordPayment` is given — needs an amount in a
 * currency, and this is the type that has one.
 */
export type PayableSupplierRun = SupplierRun & { totalCents: number; currency: string }

/** Whether this supplier's chosen bills can be settled by one payment. */
export function payableAsOneTransfer(group: SupplierRun): group is PayableSupplierRun {
  return group.currency !== null && group.totalCents !== null
}

export type RunVerdict = {
  /** The suppliers this run will actually pay. */
  suppliers: PayableSupplierRun[]
  /**
   * Suppliers left out because their chosen bills span two currencies.
   *
   * Named before the press rather than discovered during it. Phase 59 made a
   * failure in the middle of a run survivable and honestly reported, which is
   * the right safety net for what cannot be predicted — but this one can be,
   * and Phase 47's rule is that a refusal belongs on the row rather than behind
   * a button that fails when pressed.
   */
  blocked: SupplierRun[]
  /** What the run costs, in the company's own currency. */
  totalCents: number
  /** What is left in the account afterwards. Negative means it does not cover. */
  remainingCents: number
  covered: boolean
  /** A sentence, or null when there is nothing worth saying. */
  warning: string | null
  /** What to say about the blocked suppliers, or null when there are none. */
  refusal: string | null
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
  const grouped = groupBySupplier(input.chosen)
  const suppliers = grouped.filter(payableAsOneTransfer)
  const blocked = grouped.filter((group) => !payableAsOneTransfer(group))

  /**
   * Totalled in the company's currency, and over the payable suppliers only.
   *
   * Two changes from Phase 49, both the same correction. It used to add
   * supplier-currency amounts together, so a run of a €4,000 bill and a $4,000
   * bill said `$8,000.00` — and it counted suppliers the run cannot pay, so the
   * Pay button promised money that was never going to leave.
   */
  const totalCents = suppliers.reduce((sum, group) => sum + group.functionalTotalCents, 0)

  const refusal = blocked.length
    ? `${blocked.map((group) => group.vendorName).join(', ')} ` +
      `${blocked.length === 1 ? 'has' : 'have'} bills in more than one currency here. ` +
      'One payment per supplier is how the money leaves, and a single transfer cannot be in ' +
      'two currencies — untick all but one currency, and pay the rest in a second run.'
    : null

  if (input.availableCents === null) {
    return {
      suppliers,
      blocked,
      totalCents,
      remainingCents: 0,
      covered: true,
      warning: null,
      refusal,
    }
  }

  const remainingCents = input.availableCents - totalCents

  return {
    suppliers,
    blocked,
    totalCents,
    remainingCents,
    covered: remainingCents >= 0,
    warning:
      remainingCents < 0
        ? 'This is more than the account holds, going by the ledger. That figure is not the ' +
          'bank’s — a cheque written last week may not have cleared — so it is worth a look ' +
          'rather than a reason to stop.'
        : null,
    refusal,
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
