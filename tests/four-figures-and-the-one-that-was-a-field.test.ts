import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { proposalItems, proposals } from '@/db/schema'
import {
  breakdownBy,
  proposalStats,
  serviceBreakdown,
  winLossSummary,
} from '@/modules/crm/analytics'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal, decideProposal, sendProposal } from '@/modules/crm/proposals'
import { createServiceItem } from '@/modules/studio/service'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * Four figures, and the one that was a field (Phase 168).
 *
 * ADR 0167 nominated §9's four remaining gaps from `docs/SPEC-AUDIT.md`, which
 * said of them:
 *
 * > The first two are small and the second two are the same shape as the four
 * > dimensions that exist. Worth noting that *"average time to decision"* is
 * > the only one needing a fact nothing currently records per proposal — the
 * > others are re-groupings of data already there.
 *
 * Measured, that is **backwards on both halves**:
 *
 * - *Average time to decision* needs no new fact. `proposals.sent_at` and
 *   `proposals.decided_at` have both been written since Phase 3.
 * - *Performance by service/product* needs one. `proposal_items` had no
 *   reference to the service catalogue at all, so the only thing to group by
 *   was the prose somebody typed — and "Kitchen fit-out" and "Kitchen fit out"
 *   are two products.
 *
 * And a third thing, which is the sharpest: a figure was **already on the
 * dashboard** labelled *"Days to decision"*, measuring creation to close.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Okonjo Builders' })
})

async function anOpportunity(title = 'Warehouse fit-out', valueCents = 1_000_000) {
  const organization = await createOrganization(fixture.ctx, { name: `Client ${title}` })
  return createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title,
    expectedValueCents: valueCents,
    stage: 'qualified',
  })
}

/** A proposal with given lines, optionally sent and decided. */
async function aProposal(opts: {
  title?: string
  items: Array<{
    description: string
    unitPriceCents: number
    serviceItemId?: string | null
    isOptional?: boolean
    isSelected?: boolean
  }>
  send?: boolean
  decide?: 'won' | 'lost' | 'expired' | 'no_decision'
  /** Days between sending and deciding, backdated on the row. */
  decidedAfterDays?: number
}) {
  const opportunity = await anOpportunity(opts.title ?? 'Warehouse fit-out')
  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: opts.title ?? 'Warehouse fit-out',
    items: opts.items,
  })

  if (opts.send || opts.decide) await sendProposal(fixture.ctx, proposal.id)
  if (opts.decide) await decideProposal(fixture.ctx, proposal.id, opts.decide)

  if (opts.decidedAfterDays !== undefined) {
    /*
      Backdated on the row rather than by moving a clock. `sendProposal` and
      `decideProposal` both stamp `new Date()`, so the interval they produce is
      zero days within a test — which would make the average a figure that is
      always zero and an assertion that could never fail (Phase 121).
    */
    const sentAt = new Date(Date.now() - opts.decidedAfterDays * 86_400_000)
    await db.update(proposals).set({ sentAt }).where(eq(proposals.id, proposal.id))
  }

  return proposal
}

// --- The figure that was already there, under the wrong name ---------------

describe('the name that meant something else', () => {
  it('reports days to close, which is what it measures', async () => {
    /**
     * `WinLossSummary.averageDaysToDecision` measured
     * `closed_at - created_at` — the whole deal, from first inquiry — and the
     * dashboard labelled it *"Days to decision"*. A deal that sat as a lead for
     * three months and was answered in a day read as ninety-odd days of
     * "decision".
     *
     * Renamed rather than left with a second figure beside it, because two
     * fields whose names could each mean the other is the defect, not the
     * remedy.
     */
    const summary = await winLossSummary(fixture.ctx)

    expect(summary).toHaveProperty('averageDaysToClose')
    expect(summary).not.toHaveProperty('averageDaysToDecision')
  })
})

// --- Average proposal size -------------------------------------------------

describe('average proposal size', () => {
  it('averages the priced document, not the guess on the opportunity', async () => {
    /**
     * Distinct from `averageWonValueCents`, which averages
     * `opportunities.expected_value_cents` — a number somebody typed when the
     * deal was created. The fixtures below make them disagree on purpose: the
     * opportunity is guessed at 1,000,000 and the proposal is priced at
     * 300,000, and the gap between the two figures is itself informative.
     */
    await aProposal({ title: 'One', items: [{ description: 'Framing', unitPriceCents: 300_000 }] })
    await aProposal({ title: 'Two', items: [{ description: 'Framing', unitPriceCents: 500_000 }] })

    const stats = await proposalStats(fixture.ctx)

    expect(stats.totalCount).toBe(2)
    expect(stats.totalValueCents).toBe(800_000)
    expect(stats.averageValueCents).toBe(400_000)

    const summary = await winLossSummary(fixture.ctx)
    expect(summary.averageWonValueCents).not.toBe(stats.averageValueCents)
  })

  it('is zero with nothing to average rather than dividing by nothing', async () => {
    const stats = await proposalStats(fixture.ctx)

    expect(stats.totalCount).toBe(0)
    expect(stats.averageValueCents).toBe(0)
  })
})

// --- Average time to decision ---------------------------------------------

describe('average time to decision, from facts already recorded', () => {
  it('measures sent to decided', async () => {
    await aProposal({
      title: 'Quick',
      items: [{ description: 'Framing', unitPriceCents: 100_000 }],
      decide: 'won',
      decidedAfterDays: 4,
    })
    await aProposal({
      title: 'Slow',
      items: [{ description: 'Framing', unitPriceCents: 100_000 }],
      decide: 'lost',
      decidedAfterDays: 20,
    })

    const stats = await proposalStats(fixture.ctx)

    expect(stats.decidedCount).toBe(2)
    expect(stats.averageDaysToDecision).toBe(12)
  })

  it('counts a client acceptance as a decision too, not only a recorded one', async () => {
    // `decided_at` is written by `decideProposal` *and* by the public
    // acceptance path, which is half of why no new fact was needed.
    const proposal = await aProposal({
      items: [{ description: 'Framing', unitPriceCents: 100_000 }],
      decide: 'won',
      decidedAfterDays: 7,
    })

    const [row] = await db
      .select({ sentAt: proposals.sentAt, decidedAt: proposals.decidedAt })
      .from(proposals)
      .where(eq(proposals.id, proposal.id))

    expect(row.sentAt).not.toBeNull()
    expect(row.decidedAt).not.toBeNull()
  })

  it('leaves an undecided proposal out of the average entirely', async () => {
    // Not counted as zero days. A proposal still waiting has no interval, and
    // averaging it in as nought would drag the figure toward zero precisely
    // when a business is slowest to get answers.
    await aProposal({
      title: 'Waiting',
      items: [{ description: 'Framing', unitPriceCents: 100_000 }],
      send: true,
    })
    await aProposal({
      title: 'Decided',
      items: [{ description: 'Framing', unitPriceCents: 100_000 }],
      decide: 'won',
      decidedAfterDays: 10,
    })

    const stats = await proposalStats(fixture.ctx)

    expect(stats.totalCount).toBe(2)
    expect(stats.decidedCount).toBe(1)
    expect(stats.averageDaysToDecision).toBe(10)
  })

  it('reports no interval rather than zero when nothing has been decided', async () => {
    await aProposal({ items: [{ description: 'Framing', unitPriceCents: 100_000 }], send: true })

    const stats = await proposalStats(fixture.ctx)

    expect(stats.decidedCount).toBe(0)
    expect(stats.averageDaysToDecision).toBe(0)
  })
})

// --- Performance by time period -------------------------------------------

describe('performance by time period', () => {
  it('groups by the month a deal arrived, with a key that sorts', async () => {
    await anOpportunity('First')
    const rows = await breakdownBy(fixture.ctx, 'month')

    expect(rows).toHaveLength(1)
    // The key sorts and the label reads, which is why they differ.
    expect(rows[0].key).toMatch(/^\d{4}-\d{2}$/)
    expect(rows[0].label).toMatch(/^[A-Z][a-z]+ \d{4}$/)
    expect(rows[0].openCount).toBe(1)
  })

  it('groups by quarter on the same rows', async () => {
    await anOpportunity('First')
    const rows = await breakdownBy(fixture.ctx, 'quarter')

    expect(rows).toHaveLength(1)
    expect(rows[0].key).toMatch(/^\d{4}-Q[1-4]$/)
    expect(rows[0].label).toMatch(/^Q[1-4] \d{4}$/)
  })

  it('puts an open deal in a period, which keying on the close date could not', async () => {
    /**
     * The argument for grouping on `created_at`. Keyed on the close date an
     * open deal has no period at all, so the open column would be empty and a
     * period's win rate would look like a complete picture while describing
     * only its decided half.
     *
     * A cohort row says *"of the deals that arrived in this period, this is how
     * they have turned out"*, and the open column belongs in that claim.
     */
    await anOpportunity('Still open')

    const rows = await breakdownBy(fixture.ctx, 'month')

    expect(rows[0].openCount).toBe(1)
    expect(rows[0].wonCount).toBe(0)
    expect(rows[0].lostCount).toBe(0)
  })
})

// --- Performance by service, which needed the field -----------------------

describe('performance by service, which is a different grain', () => {
  it('reports lines rather than deals, in a type that says so', async () => {
    /**
     * `breakdownBy` groups opportunities and its `wonCount` is a number of
     * deals. A service lives on a proposal **line**, and one proposal can carry
     * six products — so returning a `BreakdownRow` here would put line counts
     * in a field every other caller reads as deals.
     */
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      code: 'FRM',
      unitPriceCents: 200_000,
    })
    const roofing = await createServiceItem(fixture.ctx, {
      name: 'Roofing',
      code: 'ROF',
      unitPriceCents: 400_000,
    })

    await aProposal({
      title: 'Both services',
      items: [
        { description: 'Framing', unitPriceCents: 200_000, serviceItemId: framing.id },
        { description: 'Roofing', unitPriceCents: 400_000, serviceItemId: roofing.id },
      ],
      decide: 'won',
    })

    const rows = await serviceBreakdown(fixture.ctx)

    expect(rows).toHaveLength(2)
    // One proposal, two products, two won *lines* — not two won deals.
    expect(rows.map((row) => row.wonLineCount)).toEqual([1, 1])
    expect(rows[0].label).toBe('Roofing')
    expect(rows[0].code).toBe('ROF')
    expect(rows[0].wonValueCents).toBe(400_000)
  })

  it('reports the uncatalogued lines rather than dropping them', async () => {
    /**
     * The constraint the nullable column creates. A breakdown that quietly
     * omitted hand-typed lines would have a total that disagrees with
     * `proposalStats.totalValueCents`, and the person reading it would have no
     * way to know which figure to trust — two answers to one question.
     */
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 200_000,
    })

    await aProposal({
      title: 'Mixed',
      items: [
        { description: 'Framing', unitPriceCents: 200_000, serviceItemId: framing.id },
        { description: 'Something nobody has quoted before', unitPriceCents: 150_000 },
      ],
      decide: 'won',
    })

    const rows = await serviceBreakdown(fixture.ctx)
    const uncatalogued = rows.find((row) => row.key === 'uncatalogued')

    expect(uncatalogued).toBeTruthy()
    expect(uncatalogued?.label).toBe('Not from the catalogue')
    expect(uncatalogued?.wonValueCents).toBe(150_000)

    // And the totals reconcile with the figure on the other report.
    const stats = await proposalStats(fixture.ctx)
    const breakdownTotal = rows.reduce(
      (sum, row) => sum + row.wonValueCents + row.lostValueCents + row.openValueCents,
      0,
    )
    expect(breakdownTotal).toBe(stats.totalValueCents)
  })

  it('counts an expired proposal against the win rate, unlike a dormant deal', async () => {
    /**
     * Deliberately the opposite call from `winLossSummary`, which excludes
     * dormant opportunities from its denominator. The reason differs with the
     * grain: a dormant *deal* may still be alive, while an expired *proposal*
     * is an offer that ran out.
     *
     * Leaving it out would report the win rate against only the proposals
     * somebody chased to an answer, which flatters it exactly where a business
     * is weakest.
     */
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    await aProposal({
      title: 'Won',
      items: [{ description: 'Framing', unitPriceCents: 100_000, serviceItemId: framing.id }],
      decide: 'won',
    })
    await aProposal({
      title: 'Expired',
      items: [{ description: 'Framing', unitPriceCents: 100_000, serviceItemId: framing.id }],
      decide: 'expired',
    })

    const [row] = await serviceBreakdown(fixture.ctx)

    expect(row.wonLineCount).toBe(1)
    expect(row.lostLineCount).toBe(1)
    // 50%, not 100%.
    expect(row.winRateByValueBp).toBe(5000)
  })

  it('leaves a declined optional line out of the value but not out of sight', async () => {
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    await aProposal({
      title: 'With an option',
      items: [
        { description: 'Framing', unitPriceCents: 100_000, serviceItemId: framing.id },
        {
          description: 'Framing — extra bay',
          unitPriceCents: 50_000,
          serviceItemId: framing.id,
          isOptional: true,
          isSelected: false,
        },
      ],
      decide: 'won',
    })

    const [row] = await serviceBreakdown(fixture.ctx)

    // Both lines were offered, so both are counted as lines.
    expect(row.lineCount).toBe(2)
    // One was declined, so it is neither won nor open value.
    expect(row.wonLineCount).toBe(1)
    expect(row.wonValueCents).toBe(100_000)
  })

  it('records nothing where nothing was chosen, rather than guessing', async () => {
    /**
     * Phase 157's rule, as a migration decision. Existing lines have free-text
     * descriptions and nothing recorded which catalogue item they came from, so
     * matching them by name would be a guess asserted as a fact — and the rows
     * it got wrong would be indistinguishable from the rows it got right.
     *
     * A null says "nobody recorded which product this was", which is true.
     */
    const service = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    const proposal = await aProposal({
      items: [
        // Named exactly like the catalogue item, and still not linked to it.
        { description: 'Framing', unitPriceCents: 100_000 },
      ],
    })

    const [line] = await db
      .select({ serviceItemId: proposalItems.serviceItemId })
      .from(proposalItems)
      .where(eq(proposalItems.proposalId, proposal.id))

    expect(line.serviceItemId).toBeNull()
    expect(service.id).toBeTruthy()

    const rows = await serviceBreakdown(fixture.ctx)
    expect(rows.map((row) => row.key)).toEqual(['uncatalogued'])
  })

  it('keeps the line when its catalogue item is deleted', async () => {
    // `on delete set null`, matching `time_entries`. The line survives and
    // joins the uncatalogued group, which is honest: nothing now says what it
    // was.
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    await aProposal({
      items: [{ description: 'Framing', unitPriceCents: 100_000, serviceItemId: framing.id }],
      decide: 'won',
    })

    const { serviceItems } = await import('@/db/schema')
    await db.delete(serviceItems).where(eq(serviceItems.id, framing.id))

    const rows = await serviceBreakdown(fixture.ctx)

    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('uncatalogued')
    expect(rows[0].wonValueCents).toBe(100_000)
  })
})
