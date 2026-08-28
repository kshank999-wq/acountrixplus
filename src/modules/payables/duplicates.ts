import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { bills, vendors } from '@/db/schema'
import { scoped, type ActorContext } from '@/modules/tenancy/context'
import { duplicateVerdict, type ComparableBill } from './references'

/**
 * The bills already entered twice (spec §13, §19, Phase 47).
 *
 * ## Why this exists as well as the check at the door
 *
 * `createBill` now refuses a supplier's repeated reference and warns about a
 * resemblance. That protects a business from today onwards and does nothing at
 * all for the six months of bills already in the books — which is where the
 * duplicate that gets paid twice actually is, because nothing has ever looked.
 *
 * Every phase that adds a rule owes the records that predate it a way to be
 * found. Phase 40 did this for bank accounts, Phase 46 for stranded payments;
 * this is the same debt on the payables side.
 *
 * ## Suspicion, not a verdict
 *
 * Nothing here deletes, merges or voids anything. Two bills for the same
 * amount a week apart is how a weekly delivery looks, and a machine that
 * decided on its own which of them was real would be destroying a document
 * somebody has to account for. It reports pairs; a person decides.
 */

export type DuplicatePair = {
  vendorId: string
  vendorName: string
  /** The earlier of the two. */
  keptId: string
  keptNumber: string
  keptReference: string | null
  keptIssueDate: string
  /** The later one — the one somebody would look at first. */
  suspectId: string
  suspectNumber: string
  suspectReference: string | null
  suspectIssueDate: string
  totalCents: number
  /** Whether the later one is still owed, which is what makes it urgent. */
  suspectBalanceCents: number
  why: string
}

/**
 * Pairs of bills from one supplier that look like the same document.
 *
 * Compares each bill against the ones raised before it, using the same pure
 * `duplicateVerdict` the composer uses. One implementation of the rule, so the
 * list cannot disagree with the warning that would have stopped it.
 *
 * A bill that resembles three earlier ones yields three pairs rather than one
 * cluster, because the thing a person has to decide is about two documents at
 * a time — "is this the same as that one" — and a cluster makes them do the
 * pairing themselves.
 */
export async function suspectedDuplicateBills(
  ctx: ActorContext,
  opts: { limit?: number } = {},
): Promise<DuplicatePair[]> {
  const rows = await db
    .select({
      id: bills.id,
      number: bills.number,
      vendorId: bills.vendorId,
      vendorName: vendors.name,
      vendorReference: bills.vendorReference,
      referenceKey: bills.referenceKey,
      issueDate: bills.issueDate,
      totalCents: bills.totalCents,
      balanceCents: bills.balanceCents,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    // Voided bills are excluded on both sides. A voided bill is one that should
    // never have existed, so it is the *answer* to a duplicate rather than half
    // of one — listing it would send somebody to look at a problem already
    // dealt with.
    .where(scoped(ctx, bills, ne(bills.status, 'void')))
    .orderBy(asc(bills.issueDate), asc(bills.number))

  const seen = new Map<string, typeof rows>()
  const pairs: DuplicatePair[] = []
  const limit = opts.limit ?? 100

  for (const row of rows) {
    const earlier = seen.get(row.vendorId) ?? []

    const verdict = duplicateVerdict({
      candidate: {
        vendorId: row.vendorId,
        referenceKey: row.referenceKey,
        issueDate: row.issueDate,
        totalCents: row.totalCents,
      },
      existing: earlier as ComparableBill[],
    })

    for (const match of verdict.matches) {
      const kept = earlier.find((bill) => bill.id === match.billId)
      if (!kept) continue

      pairs.push({
        vendorId: row.vendorId,
        vendorName: row.vendorName,
        keptId: kept.id,
        keptNumber: kept.number,
        keptReference: kept.vendorReference,
        keptIssueDate: kept.issueDate,
        suspectId: row.id,
        suspectNumber: row.number,
        suspectReference: row.vendorReference,
        suspectIssueDate: row.issueDate,
        totalCents: row.totalCents,
        suspectBalanceCents: row.balanceCents,
        why: match.why,
      })

      if (pairs.length >= limit) return pairs
    }

    earlier.push(row)
    seen.set(row.vendorId, earlier)
  }

  return pairs
}

/**
 * What the suspected duplicates come to, and how much is still payable.
 *
 * Two numbers rather than one, because they mean different things. The total
 * is what would have been overstated if every pair is real; the unpaid figure
 * is what can still be stopped, and it is the one worth acting on today.
 */
export async function duplicateExposure(
  ctx: ActorContext,
): Promise<{ pairs: number; totalCents: number; unpaidCents: number }> {
  const pairs = await suspectedDuplicateBills(ctx)

  return {
    pairs: pairs.length,
    totalCents: pairs.reduce((sum, pair) => sum + pair.totalCents, 0),
    unpaidCents: pairs.reduce((sum, pair) => sum + pair.suspectBalanceCents, 0),
  }
}

/** Bills from one supplier, for the composer's warning. Excludes voided. */
export async function billsForDuplicateCheck(
  ctx: ActorContext,
  vendorId: string,
): Promise<ComparableBill[]> {
  return db
    .select({
      id: bills.id,
      number: bills.number,
      vendorId: bills.vendorId,
      referenceKey: bills.referenceKey,
      issueDate: bills.issueDate,
      totalCents: bills.totalCents,
    })
    .from(bills)
    .where(scoped(ctx, bills, and(eq(bills.vendorId, vendorId), ne(bills.status, 'void'))))
}
