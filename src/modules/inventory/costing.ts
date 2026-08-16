/**
 * What a sale costs (spec §5: "Inventory, COGS"; §13).
 *
 * ## Why this file has no database import
 *
 * Cost flow is the one piece of inventory arithmetic where a subtle error is
 * invisible: the books still balance, the quantities are still right, and the
 * gross margin is quietly wrong for every period afterwards. So it is a pure
 * function over lots, exhaustively testable, and the service layer does
 * nothing but feed it rows and write down what it says.
 *
 * ## Lots, whichever method is chosen
 *
 * Every receipt of stock creates a **lot**: a quantity at a cost, on a date.
 * That is true under FIFO, where lots are the model, and it is also kept under
 * weighted average, where they are not strictly needed.
 *
 * Keeping them either way buys two things. Changing method is a setting rather
 * than a data migration. And the lots remain the audit trail for how a cost was
 * arrived at, which somebody will eventually have to explain to an auditor —
 * "the average was $4.13" is not an explanation, and "these four receipts" is.
 *
 * ## Quantities are in thousandths
 *
 * The same convention as `quantityMilli` on invoice lines. Three decimals
 * covers every unit a small business sells — 0.5 hours, 2.25 kg, 1000 sheets —
 * and integer arithmetic means no quantity ever drifts. Costs are integer
 * cents, as everywhere else (ADR 0002).
 */

export type CostMethod = 'fifo' | 'weighted_average'

export const COST_METHOD_LABELS: Record<CostMethod, string> = {
  fifo: 'First in, first out',
  weighted_average: 'Weighted average',
}

export const COST_METHOD_DESCRIPTIONS: Record<CostMethod, string> = {
  fifo:
    'The oldest stock is sold first. Cost of sales follows what you actually paid, in order.',
  weighted_average:
    'All stock of an item shares one pooled cost. Simpler, and it smooths out price swings.',
}

export function isCostMethod(value: unknown): value is CostMethod {
  return value === 'fifo' || value === 'weighted_average'
}

/**
 * An open lot: what is left of one receipt of stock.
 *
 * ## Why the value is carried and not computed
 *
 * The obvious lot is a quantity and a unit cost, with value derived as
 * `quantity × cost`. That was the first implementation and it broke the
 * subledger identity, in a way worth writing down because it looks like
 * nothing:
 *
 * ```
 *   lot A  1.000 @ 100  = 100      pool = 300 over 2.000 units
 *   lot B  1.000 @ 200  = 200
 *
 *   weighted-average sale of 1.500 costs round(300 × 1500 / 2000) = 225
 *   remaining: A empty, B holds 0.500
 *
 *   recomputed value  = round(500 × 200 / 1000) = 100
 *   ledger says       = 300 − 225                =  75      ← 25 apart
 * ```
 *
 * Deriving the value re-rounds it on every read, against a rate that the
 * pooled consumption never used. So the lot carries `remainingValueCents` as
 * the authoritative figure, consumption subtracts from it, and emptying a lot
 * takes **exactly** what is left rather than a recomputed share. The identity
 * then holds by construction rather than by luck.
 *
 * `unitCostCents` stays as the rate this stock was received at — reporting and
 * audit read it, arithmetic does not.
 */
export type Lot = {
  id: string
  /** Thousandths of a unit still on hand in this lot. */
  remainingMilli: number
  /** What is left of this lot is worth this, in cents. Authoritative. */
  remainingValueCents: number
  /** The rate it arrived at. For reading, never for arithmetic. */
  unitCostCents: number
  /** Receipt order. Ties are broken by `id` so the result is deterministic. */
  receivedAt: string
}

/** How much of one lot a consumption took, and what that part cost. */
export type Consumption = {
  lotId: string
  quantityMilli: number
  costCents: number
}

export type ConsumeResult = {
  consumed: Consumption[]
  totalCostCents: number
  /**
   * What could not be taken because there was not enough stock.
   *
   * Returned rather than thrown: whether a negative stock position is an error
   * or a fact of life is the caller's decision, not this function's. A shop
   * that sells the last one twice on a busy Saturday has a real problem to
   * record, and a costing function that refuses to compute cannot help.
   */
  shortfallMilli: number
}

/** Total units on hand across lots, in thousandths. */
export function quantityOnHand(lots: Lot[]): number {
  return lots.reduce((sum, lot) => sum + lot.remainingMilli, 0)
}

/** What the stock on hand is worth, in cents. Summed, never recomputed. */
export function valueOnHand(lots: Lot[]): number {
  return lots.reduce((sum, lot) => sum + lot.remainingValueCents, 0)
}

/**
 * The pooled cost of one unit, in cents, or null when there is nothing on hand.
 *
 * Rounded for display only. Consumption never multiplies by this figure — see
 * `consume` for why that matters.
 */
export function averageUnitCostCents(lots: Lot[]): number | null {
  const quantity = quantityOnHand(lots)
  if (quantity === 0) return null
  return Math.round((valueOnHand(lots) * 1000) / quantity)
}

/**
 * Cost of a quantity of thousandths at a whole-unit price.
 *
 * One place, because getting the rounding wrong here is how a system ends up
 * with an inventory account that misses the subledger by a few cents a month
 * and nobody can say where it went.
 */
export function extend(quantityMilli: number, unitCostCents: number): number {
  return Math.round((quantityMilli * unitCostCents) / 1000)
}

/**
 * Takes stock out, and says what it cost.
 *
 * ## FIFO
 *
 * Oldest lot first, in receipt order. Nothing subtle beyond the tie-break: two
 * receipts on the same day must consume in a defined order or two runs of the
 * same report disagree.
 *
 * ## Weighted average
 *
 * Consumed proportionally across every open lot, so the total comes to exactly
 * the quantity times the pooled average — and, critically, **the last lot
 * takes the remainder** rather than its own rounded share.
 *
 * That detail is the whole reason this is not three lines. Rounding each lot's
 * share independently and adding them up gives a total that differs from
 * `quantity × average` by a cent or two, and that cent is the difference
 * between the inventory subledger and the Inventory account in the ledger. It
 * appears once a week, drifts forever, and is exactly the kind of unexplainable
 * variance that destroys confidence in a set of books. The same technique is
 * used by `prorate` in the cash-basis code, for the same reason.
 */
export function consume(lots: Lot[], quantityMilli: number, method: CostMethod): ConsumeResult {
  if (quantityMilli <= 0) {
    return { consumed: [], totalCostCents: 0, shortfallMilli: 0 }
  }

  const available = quantityOnHand(lots)
  const taking = Math.min(quantityMilli, available)
  const shortfallMilli = quantityMilli - taking

  if (taking === 0) {
    return { consumed: [], totalCostCents: 0, shortfallMilli }
  }

  const ordered = [...lots]
    .filter((lot) => lot.remainingMilli > 0)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))

  if (method === 'fifo') {
    const consumed: Consumption[] = []
    let left = taking

    for (const lot of ordered) {
      if (left === 0) break
      const fromThisLot = Math.min(left, lot.remainingMilli)

      // Emptying a lot takes exactly what is left in it. Recomputing a share
      // from the rate would leave a cent behind in a lot with no quantity —
      // value with nothing under it, which no report can explain.
      const costCents =
        fromThisLot === lot.remainingMilli
          ? lot.remainingValueCents
          : Math.round((lot.remainingValueCents * fromThisLot) / lot.remainingMilli)

      consumed.push({ lotId: lot.id, quantityMilli: fromThisLot, costCents })
      left -= fromThisLot
    }

    return {
      consumed,
      totalCostCents: consumed.reduce((sum, entry) => sum + entry.costCents, 0),
      shortfallMilli,
    }
  }

  // Weighted average. The target is computed once, from the pool, and the
  // per-lot shares are made to add up to it exactly.
  const poolValue = valueOnHand(ordered)
  const targetCostCents =
    taking === available ? poolValue : Math.round((poolValue * taking) / available)

  const consumed: Consumption[] = []
  let quantityLeft = taking
  let costAllocated = 0

  for (let index = 0; index < ordered.length; index++) {
    if (quantityLeft === 0) break
    const lot = ordered[index]
    const fromThisLot = Math.min(quantityLeft, lot.remainingMilli)
    const isLastTouched = quantityLeft <= lot.remainingMilli || index === ordered.length - 1

    // Two clamps, and each fixes a different way this drifts:
    //
    //  - the last lot touched takes whatever cost is left, so the parts sum to
    //    the pooled total rather than to the total plus a rounding error;
    //  - a lot emptied along the way gives up exactly its remaining value, so
    //    no lot is ever left holding value with no quantity behind it.
    let costCents: number
    if (isLastTouched) {
      costCents = targetCostCents - costAllocated
    } else if (fromThisLot === lot.remainingMilli) {
      costCents = lot.remainingValueCents
    } else {
      costCents = Math.round((targetCostCents * fromThisLot) / taking)
    }

    consumed.push({ lotId: lot.id, quantityMilli: fromThisLot, costCents })
    quantityLeft -= fromThisLot
    costAllocated += costCents
  }

  return {
    consumed,
    totalCostCents: consumed.reduce((sum, entry) => sum + entry.costCents, 0),
    shortfallMilli,
  }
}

/**
 * Applies a consumption to a set of lots, returning the lots that remain.
 *
 * Pure, so a caller can preview the effect of a sale — what it would cost, and
 * what would be left — without writing anything. The UI uses it to show a
 * margin before an invoice is issued.
 */
export function applyConsumption(lots: Lot[], consumed: Consumption[]): Lot[] {
  const taken = new Map<string, { quantityMilli: number; costCents: number }>()
  for (const entry of consumed) {
    const running = taken.get(entry.lotId) ?? { quantityMilli: 0, costCents: 0 }
    running.quantityMilli += entry.quantityMilli
    running.costCents += entry.costCents
    taken.set(entry.lotId, running)
  }

  return lots
    .map((lot) => {
      const gone = taken.get(lot.id)
      if (!gone) return lot
      return {
        ...lot,
        remainingMilli: lot.remainingMilli - gone.quantityMilli,
        remainingValueCents: lot.remainingValueCents - gone.costCents,
      }
    })
    .filter((lot) => lot.remainingMilli > 0)
}

/**
 * The cost to put back when a sale is undone.
 *
 * A return restores the stock **at the cost it left at**, not at today's
 * average. Restoring at today's cost would create or destroy value out of
 * nothing: sell at $4, prices rise, take the return back in at $6, and the
 * business has invented $2 of inventory with no transaction behind it.
 */
export function reversalLot(consumed: Consumption[], receivedAt: string, id: string): Lot | null {
  const quantityMilli = consumed.reduce((sum, entry) => sum + entry.quantityMilli, 0)
  if (quantityMilli === 0) return null

  const costCents = consumed.reduce((sum, entry) => sum + entry.costCents, 0)

  return {
    id,
    remainingMilli: quantityMilli,
    // The value is what left, to the cent. The rate is derived from it for
    // display, and is the one figure here allowed to round.
    remainingValueCents: costCents,
    unitCostCents: Math.round((costCents * 1000) / quantityMilli),
    receivedAt,
  }
}
