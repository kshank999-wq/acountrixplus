import { extend } from '@/modules/inventory/costing'

/**
 * What a batch needs, and what a batch cost (spec §5, "Manufacturing — raw
 * materials, WIP, finished goods, BOM/costing").
 *
 * A pure core, with no database and no clock, for the same reason
 * `depreciationSchedule`, `rentFor` and `releaseFor` are ones: this is the
 * arithmetic somebody will dispute, and the dispute is usually about a unit
 * cost that came out higher than a quote.
 *
 * ## The claim this file exists to make true
 *
 * **Cost moves with the material, and nothing is created or destroyed.** Every
 * penny of material issued to a run comes out again in the finished goods, to
 * the cent — so `unitCostOf` never rounds a total, only the per-unit rate, and
 * the caller is given the exact total to post.
 */

/** One line of a bill of materials, expanded for a particular run. */
export type BomLine = {
  componentItemId: string
  /** Thousandths of a component per batch. */
  quantityMilli: number
  /**
   * Expected wastage, in basis points of the quantity.
   *
   * Ratios are basis points everywhere in this application, and this is a
   * ratio: 250 is 2.5% and means "ask for 2.5% more than the drawing says,
   * because that much of it ends up on the floor".
   */
  scrapBp: number
}

export type Requirement = {
  componentItemId: string
  /** What the drawing says, before wastage. */
  netMilli: number
  /** What to actually take out of the store. */
  grossMilli: number
}

/**
 * What a run of `quantityMilli` needs, from a BOM written per batch.
 *
 * `batchMilli` is the quantity the BOM is written for — a recipe for 100 loaves
 * scaled to a run of 250. Written as a ratio rather than a per-unit figure
 * because a BOM for one unit of something that is made in hundreds forces every
 * component quantity through a rounding it did not need.
 */
export function explodeBom(
  lines: BomLine[],
  batchMilli: number,
  quantityMilli: number,
): Requirement[] {
  if (batchMilli <= 0) throw new Error('A bill of materials has to make something.')

  return lines.map((line) => {
    // Scaled in one step rather than per-unit then multiplied, so a component
    // used 1/3 of a time per unit does not accumulate a third of a thousandth
    // of error on every unit of the run.
    const netMilli = Math.round((line.quantityMilli * quantityMilli) / batchMilli)
    const grossMilli = netMilli + Math.round((netMilli * line.scrapBp) / 10_000)

    return { componentItemId: line.componentItemId, netMilli, grossMilli }
  })
}

export type RunCost = {
  materialCents: number
  labourCents: number
  overheadCents: number
  /** Everything the run absorbed. This is what must leave WIP. */
  totalCents: number
  /** Cost of one whole unit of good output, rounded. */
  unitCostCents: number
  /**
   * What a lot of `goodMilli` at `unitCostCents` actually extends to.
   *
   * Almost always `totalCents`, and when it is not, the difference is the
   * rounding that `completeWorkOrder` has to deal with rather than ignore.
   */
  extendedCents: number
  /** `totalCents - extendedCents`. Posted somewhere, never dropped. */
  roundingCents: number
}

/**
 * What a finished unit cost, given everything the run absorbed.
 *
 * ## Scrap raises the unit cost, and that is the point
 *
 * A run that consumed the material for 100 and yielded 95 good units cost the
 * same money and produced less. The 95 carry all of it, so the unit cost rises
 * by about 5% — which is the number a production manager needs to see and the
 * number a "cost per unit from the BOM" would never show them.
 *
 * This is normal scrap, absorbed into the good output. Abnormal scrap — a
 * batch ruined by a machine fault — should be expensed rather than capitalised
 * into the survivors, and this module does not distinguish the two. It is
 * named in ADR 0027 as a limitation rather than pretended away.
 *
 * ## The rounding is returned, not swallowed
 *
 * £100.00 of cost over 3 good units is £33.333… each. Whatever unit rate is
 * chosen, three lots of it will not be £100.00. `totalCents` is what has to
 * leave WIP, `extendedCents` is what a lot at that rate is worth, and the
 * difference is handed back for the caller to post deliberately — because a
 * penny quietly dropped here is a penny of WIP that never clears, forever.
 */
export function unitCostOf(input: {
  materialCents: number
  labourCents: number
  overheadCents: number
  /** Thousandths of good output. Scrap is excluded — that is what makes it scrap. */
  goodMilli: number
}): RunCost {
  const totalCents = input.materialCents + input.labourCents + input.overheadCents

  if (input.goodMilli <= 0) {
    return {
      materialCents: input.materialCents,
      labourCents: input.labourCents,
      overheadCents: input.overheadCents,
      totalCents,
      unitCostCents: 0,
      extendedCents: 0,
      roundingCents: totalCents,
    }
  }

  const unitCostCents = Math.round((totalCents * 1000) / input.goodMilli)
  const extendedCents = extend(input.goodMilli, unitCostCents)

  return {
    materialCents: input.materialCents,
    labourCents: input.labourCents,
    overheadCents: input.overheadCents,
    totalCents,
    unitCostCents,
    extendedCents,
    roundingCents: totalCents - extendedCents,
  }
}

export type YieldReport = {
  plannedMilli: number
  goodMilli: number
  scrappedMilli: number
  /** Good output as a share of what was planned, in basis points. */
  yieldBp: number
  /** Scrap as a share of everything that came off the line, in basis points. */
  scrapBp: number
}

/**
 * How a run went against what was asked for.
 *
 * Two different denominators, deliberately. **Yield** is against the plan —
 * "we asked for 100 and got 95" — and is the number that decides whether the
 * order can be filled. **Scrap rate** is against total output — "of the 98 we
 * actually made, 3 were bad" — and is the number that says whether the process
 * is in control. A run that made only half the plan because it was stopped
 * early has a terrible yield and perfect scrap, and collapsing the two into one
 * figure would hide which of those happened.
 */
export function yieldOf(plannedMilli: number, goodMilli: number, scrappedMilli: number): YieldReport {
  const producedMilli = goodMilli + scrappedMilli

  return {
    plannedMilli,
    goodMilli,
    scrappedMilli,
    yieldBp: plannedMilli > 0 ? Math.round((goodMilli * 10_000) / plannedMilli) : 0,
    scrapBp: producedMilli > 0 ? Math.round((scrappedMilli * 10_000) / producedMilli) : 0,
  }
}

export type ComponentVariance = {
  componentItemId: string
  expectedMilli: number
  issuedMilli: number
  /** Positive means more was used than the BOM allowed for. */
  varianceMilli: number
}

/**
 * What the BOM expected against what the store actually gave out.
 *
 * A quantity variance, not a price one. Material is issued at whatever the lots
 * cost (Phase 14 decides that, by FIFO or weighted average), so a run that cost
 * more than expected did so either because it used more material or because the
 * material itself had gone up — and mixing those two into a single number tells
 * a production manager nothing they can act on. This answers the half they
 * control.
 */
export function componentVariance(
  expected: Requirement[],
  issued: Array<{ componentItemId: string; quantityMilli: number }>,
): ComponentVariance[] {
  const issuedBy = new Map<string, number>()
  for (const row of issued) {
    issuedBy.set(row.componentItemId, (issuedBy.get(row.componentItemId) ?? 0) + row.quantityMilli)
  }

  const rows: ComponentVariance[] = expected.map((requirement) => {
    const issuedMilli = issuedBy.get(requirement.componentItemId) ?? 0
    issuedBy.delete(requirement.componentItemId)

    return {
      componentItemId: requirement.componentItemId,
      expectedMilli: requirement.grossMilli,
      issuedMilli,
      varianceMilli: issuedMilli - requirement.grossMilli,
    }
  })

  // Anything issued that the BOM never mentioned. Left in rather than filtered
  // out: a substitution nobody recorded is exactly what somebody investigating
  // an overspend is looking for, and a report that only lists expected
  // components cannot show it.
  for (const [componentItemId, issuedMilli] of issuedBy) {
    rows.push({ componentItemId, expectedMilli: 0, issuedMilli, varianceMilli: issuedMilli })
  }

  return rows
}
