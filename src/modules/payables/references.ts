/**
 * The supplier's reference, and the bill entered twice (spec §13, §19).
 *
 * ## Two failures, one cause
 *
 * `bills.number` has carried two different things since Phase 2. The system
 * generates `BILL-1002` into it, and the composer's field — labelled *"Their
 * reference"*, placeholder `INV-4471` — writes the **supplier's own** number
 * into the same column. That column is unique per *company*.
 *
 * So the constraint is wrong in both directions at once:
 *
 * - **It refuses what it should allow.** Two different suppliers both using
 *   `INV-4471`, or `1234`, or `2026-001` — which is not a coincidence, it is
 *   how invoice numbering works — collide. The second bill fails on a raw
 *   unique violation, and because `createBill` throws a plain `Error` that
 *   reaches the user as *"Something went wrong."* A business cannot enter a
 *   real supplier invoice and is told nothing about why.
 *
 * - **It allows what it should refuse.** The same supplier's same invoice,
 *   entered twice — once from the emailed PDF, once from the posted copy — is
 *   only caught if somebody typed the reference both times. The field is
 *   optional, so the safe path is the one nobody takes, and the two rows get
 *   different system numbers and both get paid. Paying a supplier twice is the
 *   most expensive routine mistake in small-business bookkeeping.
 *
 * A reference is the supplier's, and it identifies a document **within that
 * supplier**. That is the whole fix, and everything here follows from it.
 *
 * ## The costly wrong answer
 *
 * Not "warning about a bill that turns out to be fine" — that costs a click.
 * It is **refusing a real supplier invoice**. A business that cannot enter what
 * arrived has to keep it on paper, and the books are wrong until somebody
 * fights the software. So only one case is refused: the same supplier's same
 * reference, which is not a resemblance but the same document by definition.
 * Everything else warns and lets a person decide.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * A supplier reference reduced to what it identifies.
 *
 * Suppliers are inconsistent about their own numbers — `INV-4471`, `inv 4471`,
 * `INV/4471` and `#INV-4471` come off three systems and a rubber stamp, and
 * they are the same invoice. Case, spaces and punctuation are noise; the
 * letters and digits are the reference.
 *
 * Returns null for anything with no letters or digits at all, because a
 * reference of `-` identifies nothing and must not make two unrelated bills
 * collide.
 */
export function normaliseReference(raw: string | null | undefined): string | null {
  if (!raw) return null

  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return key.length === 0 ? null : key
}

/** What a business does about a bill that resembles one already entered. */
export type DuplicateAction =
  /** The same document. Not enterable, and the reason names the existing one. */
  | 'refuse'
  /** Resembles one already entered. Enterable once somebody has looked. */
  | 'warn'
  /** Nothing like it. */
  | 'allow'

/** A bill as this module needs to compare it. */
export type ComparableBill = {
  id: string
  /** Our number, for naming the existing bill in a sentence. */
  number: string
  vendorId: string
  /** The supplier's own reference, normalised. Null when they gave none. */
  referenceKey: string | null
  issueDate: string
  totalCents: number
}

/** A bill somebody is about to enter. No id yet. */
export type CandidateBill = Omit<ComparableBill, 'id' | 'number'>

export type DuplicateMatch = {
  billId: string
  number: string
  /** Why this one was matched, in a sentence somebody can act on. */
  why: string
}

export type DuplicateVerdict = {
  action: DuplicateAction
  matches: DuplicateMatch[]
}

/**
 * How close two dates have to be for the same amount to look like a re-entry.
 *
 * A fortnight. Long enough to cover the gap between an emailed invoice and the
 * posted copy landing in somebody's in-tray, short enough that a genuine
 * monthly charge of the same amount — rent, a retainer, a standing order — is
 * outside it and passes without a warning nobody would read by the third
 * month.
 */
export const NEAR_DATE_DAYS = 14

/**
 * What to do about a bill somebody is entering.
 *
 * The order is the argument. A shared reference from the same supplier is the
 * same document and is refused; everything else is a resemblance, and a
 * resemblance is a question for a person rather than an answer from a machine.
 */
export function duplicateVerdict(input: {
  candidate: CandidateBill
  /** Open and settled bills from the same supplier. Voided ones are excluded. */
  existing: ComparableBill[]
}): DuplicateVerdict {
  const { candidate } = input

  // Only the same supplier's bills can be duplicates of this one. A different
  // supplier using the same number is the collision this phase exists to stop
  // being an error at all.
  const sameVendor = input.existing.filter((bill) => bill.vendorId === candidate.vendorId)

  if (candidate.referenceKey) {
    const shared = sameVendor.filter((bill) => bill.referenceKey === candidate.referenceKey)

    if (shared.length > 0) {
      return {
        action: 'refuse',
        matches: shared.map((bill) => ({
          billId: bill.id,
          number: bill.number,
          why: `This supplier's reference is already on ${bill.number}, dated ${bill.issueDate}.`,
        })),
      }
    }
  }

  // No shared reference. Now the resemblances, and each one only reported once
  // — a bill that matches on amount and date must not also be listed as
  // matching on amount alone.
  const matches: DuplicateMatch[] = []

  for (const bill of sameVendor) {
    if (bill.totalCents !== candidate.totalCents) continue

    // Both carry a reference and they differ, so the supplier has already
    // said these are two documents. A builder invoicing two sites for the same
    // amount on the same day is ordinary, and warning about it every time is
    // how a warning stops being read.
    if (bill.referenceKey && candidate.referenceKey) continue

    if (bill.issueDate === candidate.issueDate) {
      matches.push({
        billId: bill.id,
        number: bill.number,
        why: `${bill.number} is for the same amount, dated the same day.`,
      })
      continue
    }

    const apart = Math.abs(daysBetween(bill.issueDate, candidate.issueDate))
    if (apart <= NEAR_DATE_DAYS) {
      matches.push({
        billId: bill.id,
        number: bill.number,
        why: `${bill.number} is for the same amount, dated ${bill.issueDate}.`,
      })
    }
  }

  return { action: matches.length > 0 ? 'warn' : 'allow', matches }
}

/** Whole days between two ISO dates. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/**
 * The sentence a person reads, or null when there is nothing to say.
 *
 * A refusal names the bill it clashes with, because "duplicate reference" with
 * no reference to the other document leaves somebody searching a list. A
 * warning says what matched and hands the decision back rather than making it.
 */
export function describeDuplicate(verdict: DuplicateVerdict): string | null {
  if (verdict.action === 'allow' || verdict.matches.length === 0) return null

  const reasons = verdict.matches.map((match) => match.why).join(' ')

  if (verdict.action === 'refuse') {
    return `${reasons} A supplier does not send two invoices under one number, so this is the same bill. Enter it under its own reference, or open the one already here.`
  }

  return `${reasons} If this is the same bill arriving twice, do not enter it again — paying a supplier twice is hard to get back.`
}

/**
 * Whether a warned-about bill may be entered.
 *
 * A refusal is not overridable and a warning always is. Stated as a function
 * rather than an `if` at the call site so the rule lives with the reasoning:
 * the machine is certain about exactly one thing, and everywhere else the
 * person entering the bill is holding it and the machine is not.
 */
export function mayProceed(verdict: DuplicateVerdict, acknowledged: boolean): boolean {
  if (verdict.action === 'refuse') return false
  if (verdict.action === 'allow') return true
  return acknowledged
}
