import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { opportunities, proposalVersions, proposalViews } from '@/db/schema'
import { addUserWithRole, createCompanyFixture } from './helpers'
import { createOpportunity, createOrganization, changeStage } from '@/modules/crm/opportunities'
import {
  computeTotals,
  createProposal,
  decideProposal,
  getProposal,
  itemAmountCents,
  listProposals,
  proposalByToken,
  recordView,
  sendProposal,
  setBillingSchedule,
  updateProposalItems,
} from '@/modules/crm/proposals'
import { proposalStats } from '@/modules/crm/analytics'
import { setModuleEnabled } from '@/modules/industry/modules'
import { convertWonOpportunity } from '@/modules/crm/conversion'
import { PermissionError } from '@/modules/permissions'

/** Proposal pricing and lifecycle (spec §7, §9). */
describe('proposal pricing', () => {
  it('extends quantity by unit price in exact cents', () => {
    expect(itemAmountCents(1000, 250_000)).toBe(250_000)
    expect(itemAmountCents(2500, 40_000)).toBe(100_000)
    expect(itemAmountCents(1500, 3_333)).toBe(5_000)
  })

  it('excludes unselected optional items from the subtotal', () => {
    const totals = computeTotals([
      { amountCents: 100_000, isOptional: false, isSelected: true },
      { amountCents: 50_000, isOptional: true, isSelected: false },
      { amountCents: 25_000, isOptional: true, isSelected: true },
    ])

    // Base plus the selected option only.
    expect(totals.subtotalCents).toBe(125_000)
    expect(totals.totalCents).toBe(125_000)
  })

  it('applies discount and tax to the total', () => {
    const totals = computeTotals([{ amountCents: 100_000, isOptional: false, isSelected: true }], {
      discountCents: 10_000,
      taxCents: 7_425,
    })

    expect(totals.totalCents).toBe(97_425)
  })
})

async function proposalFixture() {
  const fixture = await createCompanyFixture()
  const organization = await createOrganization(fixture.ctx, { name: 'Harborview' })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Foundation package',
    expectedValueCents: 2_500_000,
  })
  const revenue = await fixture.account('4000')

  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Foundation proposal',
    items: [
      {
        description: 'Excavation and foundation',
        unitPriceCents: 1_800_000,
        chartAccountId: revenue.id,
      },
      {
        description: 'Drainage upgrade',
        unitPriceCents: 400_000,
        isOptional: true,
        isSelected: false,
        chartAccountId: revenue.id,
      },
    ],
  })

  return { fixture, organization, opportunity, proposal, revenue }
}

describe('proposal lifecycle', () => {
  it('starts as a draft with an unguessable public token', async () => {
    const { proposal } = await proposalFixture()

    expect(proposal.status).toBe('draft')
    expect(proposal.number).toBe('PROP-1001')
    // The optional item is unselected, so it is not in the total.
    expect(proposal.totalCents).toBe(1_800_000)
    expect(proposal.publicToken.length).toBeGreaterThan(20)
  })

  it('gives every proposal a different token', async () => {
    const { fixture, opportunity, proposal, revenue } = await proposalFixture()

    const second = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Revised',
      items: [{ description: 'Work', unitPriceCents: 100_000, chartAccountId: revenue.id }],
    })

    expect(second.publicToken).not.toBe(proposal.publicToken)
  })

  it('snapshots the proposal when sent', async () => {
    const { fixture, proposal } = await proposalFixture()

    const { versionNumber } = await sendProposal(fixture.ctx, proposal.id)
    expect(versionNumber).toBe(1)

    const [version] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposal.id))

    expect(version.totalCents).toBe(1_800_000)
    expect((version.snapshot as { items: unknown[] }).items).toHaveLength(2)
  })

  it('keeps the sent snapshot unchanged when the proposal is edited', async () => {
    const { fixture, proposal, revenue } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)

    await updateProposalItems(fixture.ctx, proposal.id, [
      { description: 'Revised scope', unitPriceCents: 2_900_000, chartAccountId: revenue.id },
    ])

    const [version] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposal.id))

    // What the client was shown is preserved.
    expect(version.totalCents).toBe(1_800_000)

    const { proposal: current } = await getProposal(fixture.ctx, proposal.id)
    expect(current.totalCents).toBe(2_900_000)
  })

  it('creates a new version on each send', async () => {
    const { fixture, proposal, revenue } = await proposalFixture()

    await sendProposal(fixture.ctx, proposal.id)
    await updateProposalItems(fixture.ctx, proposal.id, [
      { description: 'Revised', unitPriceCents: 2_000_000, chartAccountId: revenue.id },
    ])
    const second = await sendProposal(fixture.ctx, proposal.id)

    expect(second.versionNumber).toBe(2)

    const { versions } = await getProposal(fixture.ctx, proposal.id)
    expect(versions.map((v) => v.totalCents)).toEqual([2_000_000, 1_800_000])
  })

  it('advances the opportunity to proposal sent', async () => {
    const { fixture, opportunity, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)

    const [updated] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(updated.stage).toBe('proposal_sent')
  })

  it('does not drag a deal already past proposal sent backwards', async () => {
    // Regression: sending a revised proposal to a deal in negotiation used to
    // move it back to "proposal sent" and misstate its forecast weight.
    const { fixture, opportunity, proposal } = await proposalFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'negotiation' })

    await sendProposal(fixture.ctx, proposal.id)

    const [unchanged] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(unchanged.stage).toBe('negotiation')
    expect(unchanged.probability).toBe(80)
  })

  it('advances probability along with the stage when sent', async () => {
    const { fixture, opportunity, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)

    const [updated] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(updated.stage).toBe('proposal_sent')
    expect(updated.probability).toBe(50)
  })

  it('leaves a hand-set probability alone when sending', async () => {
    const { fixture, opportunity, proposal } = await proposalFixture()
    const { updateOpportunity } = await import('@/modules/crm/opportunities')
    await updateOpportunity(fixture.ctx, opportunity.id, { probability: 35 })

    await sendProposal(fixture.ctx, proposal.id)

    const [updated] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(updated.stage).toBe('proposal_sent')
    expect(updated.probability).toBe(35)
  })

  it('raises probability when the client opens the proposal', async () => {
    const { fixture, opportunity, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)
    await recordView(proposal.publicToken, {})

    const [updated] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(updated.stage).toBe('viewed')
    expect(updated.probability).toBe(60)
  })

  it('does not drag a closed opportunity back open', async () => {
    const { fixture, opportunity, proposal } = await proposalFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })

    await sendProposal(fixture.ctx, proposal.id)

    const [unchanged] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))
    expect(unchanged.stage).toBe('won')
  })

  it('refuses to record a decision on a draft', async () => {
    const { fixture, proposal } = await proposalFixture()

    await expect(decideProposal(fixture.ctx, proposal.id, 'won')).rejects.toThrow(
      /send the proposal before/i,
    )
  })

  it('records a decision on a sent proposal', async () => {
    const { fixture, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)

    const decided = await decideProposal(fixture.ctx, proposal.id, 'won')
    expect(decided.status).toBe('won')
    expect(decided.decidedAt).not.toBeNull()
  })
})

/** Client-facing link and view tracking (spec §9). */
describe('proposal views', () => {
  it('advances sent to viewed on first open', async () => {
    const { fixture, proposal, opportunity } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)

    await recordView(proposal.publicToken, { ipPrefix: '203.0.113.0/24' })

    const { proposal: updated } = await getProposal(fixture.ctx, proposal.id)
    expect(updated.status).toBe('viewed')
    expect(updated.viewCount).toBe(1)
    expect(updated.firstViewedAt).not.toBeNull()

    const [opp] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))
    expect(opp.stage).toBe('viewed')
  })

  it('counts repeat views without resetting the first', async () => {
    const { fixture, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)

    await recordView(proposal.publicToken, {})
    const { proposal: afterFirst } = await getProposal(fixture.ctx, proposal.id)
    await recordView(proposal.publicToken, {})

    const { proposal: afterSecond } = await getProposal(fixture.ctx, proposal.id)
    expect(afterSecond.viewCount).toBe(2)
    expect(afterSecond.firstViewedAt?.getTime()).toBe(afterFirst.firstViewedAt?.getTime())

    const views = await db
      .select()
      .from(proposalViews)
      .where(eq(proposalViews.proposalId, proposal.id))
    expect(views).toHaveLength(2)
  })

  it('does not change the status of a decided proposal', async () => {
    const { fixture, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)
    await decideProposal(fixture.ctx, proposal.id, 'won')

    await recordView(proposal.publicToken, {})

    const { proposal: updated } = await getProposal(fixture.ctx, proposal.id)
    expect(updated.status).toBe('won')
  })

  it('ignores an unknown token instead of erroring', async () => {
    expect(await recordView('not-a-real-token', {})).toBeNull()
  })

  it('serves a proposal by its token without an actor', async () => {
    const { proposal } = await proposalFixture()
    const view = await proposalByToken(proposal.publicToken)

    expect(view?.proposal.number).toBe('PROP-1001')
    expect(view?.organizationName).toBe('Harborview')
    expect(view?.items).toHaveLength(2)
  })
})

/** Proposal statistics (spec §9). */
describe('proposal analytics', () => {
  it('counts and values proposals by status', async () => {
    const { fixture, opportunity, proposal, revenue } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)
    await decideProposal(fixture.ctx, proposal.id, 'won')

    const second = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Second',
      items: [{ description: 'Work', unitPriceCents: 500_000, chartAccountId: revenue.id }],
    })
    await sendProposal(fixture.ctx, second.id)

    const stats = await proposalStats(fixture.ctx)

    expect(stats.totalCount).toBe(2)
    expect(stats.byStatus.won?.count).toBe(1)
    expect(stats.byStatus.won?.valueCents).toBe(1_800_000)
    expect(stats.byStatus.sent?.count).toBe(1)
  })

  it('reports the view rate over proposals that reached a client', async () => {
    const { fixture, opportunity, proposal, revenue } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)
    await recordView(proposal.publicToken, {})

    const unopened = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Unopened',
      items: [{ description: 'Work', unitPriceCents: 100_000, chartAccountId: revenue.id }],
    })
    await sendProposal(fixture.ctx, unopened.id)

    // A draft never reached anyone, so it is not in the denominator.
    await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Still drafting',
      items: [{ description: 'Work', unitPriceCents: 100_000, chartAccountId: revenue.id }],
    })

    const stats = await proposalStats(fixture.ctx)
    expect(stats.viewRateBp).toBe(5_000)
  })
})

/** Won proposal to invoice schedule (spec §6). */
describe('proposal to invoice', () => {
  it('raises nothing when the proposal says nothing about when it is billed', async () => {
    /**
     * **This test asserted the opposite until Phase 154**, and what it asserted
     * was the defect:
     *
     * ```ts
     * // Only the selected item is billed, matching the proposal total.
     * expect(invoice.totalCents).toBe(1_800_000)
     * ```
     *
     * That is the whole contract, invoiced on the day of conversion. Spec §6 asks
     * for an invoice *schedule* and `conversion.ts` quoted that sentence while
     * billing a $18,000 proposal — or a $500,000 one — in full on signing day,
     * before any work was done. The test agreed with the code because both were
     * written from the same idea, which is Phase 121's rule: a check that cannot
     * disagree is not a check.
     *
     * Settled rather than deleted. A proposal with no billing schedule has agreed
     * no payment terms, so conversion raises nothing and the client gets no
     * invoice until somebody decides what to bill. Inventing a schedule here
     * would be inventing terms nobody agreed to; billing the lot is what this
     * replaced.
     */
    const { fixture, opportunity, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)
    await decideProposal(fixture.ctx, proposal.id, 'won')
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })

    const result = await convertWonOpportunity(fixture.ctx, opportunity.id, {
      createInvoice: true,
    })

    expect(result.depositInvoiceId).toBeNull()
    expect(result.sovStageCount).toBe(0)

    // And nothing was raised at all, which is the part that matters: the client
    // is not holding an invoice for work that has not started.
    const { invoices } = await import('@/db/schema')
    const raised = await db
      .select()
      .from(invoices)
      .where(eq(invoices.customerId, result.customerId))
    expect(raised).toHaveLength(0)
  })

  it('bills the deposit and schedules the rest when the proposal says so', async () => {
    const { fixture, opportunity, proposal } = await proposalFixture()
    // Job costing on, because the schedule of values is where the earning stages
    // go and that is a job-costing artifact. The schedule itself does **not**
    // need the module — the next test's company does not have it — which is the
    // distinction running this found: `setScheduleOfValues` calls
    // `requireModule`, so telling the job unconditionally threw the whole
    // conversion for any company that does not bill progressively.
    await setModuleEnabled(fixture.ctx, 'job_costing', true)
    await setBillingSchedule(fixture.ctx, proposal.id, [
      { label: 'On signing', kind: 'deposit', percentBp: 2_500 },
      { label: 'Foundation poured', kind: 'milestone', percentBp: 2_500 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ])
    await sendProposal(fixture.ctx, proposal.id)
    await decideProposal(fixture.ctx, proposal.id, 'won')
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })

    const result = await convertWonOpportunity(fixture.ctx, opportunity.id, {
      createInvoice: true,
    })

    // 25% of $18,000 is payable now. The other 75% is work, and is on the job.
    expect(result.depositInvoiceId).not.toBeNull()
    expect(result.sovStageCount).toBe(2)

    const { invoices } = await import('@/db/schema')
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, result.depositInvoiceId!))

    expect(invoice.totalCents).toBe(450_000)
    expect(invoice.customerId).toBe(result.customerId)
  })

  it('posts the deposit to unearned revenue, not to revenue', async () => {
    // The distinction the phase is built on. Money taken before any work is a
    // liability until it is earned — `2500 Unearned Revenue`, whose entry in the
    // chart of accounts says exactly that. Crediting revenue instead would
    // recognise a quarter of the contract on signing day, which is the defect
    // one step smaller.
    const { fixture, opportunity, proposal, revenue } = await proposalFixture()
    await setBillingSchedule(fixture.ctx, proposal.id, [
      { label: 'On signing', kind: 'deposit', percentBp: 2_500 },
      { label: 'On handover', kind: 'on-completion', percentBp: 7_500 },
    ])
    await sendProposal(fixture.ctx, proposal.id)
    await decideProposal(fixture.ctx, proposal.id, 'won')
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })

    const result = await convertWonOpportunity(fixture.ctx, opportunity.id, {
      createInvoice: true,
    })

    const { chartAccounts, journalEntries, journalLines } = await import('@/db/schema')
    const lines = await db
      .select({ number: chartAccounts.number, credit: journalLines.creditCents })
      .from(journalLines)
      .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(eq(journalEntries.sourceId, result.depositInvoiceId!))

    const credited = lines.filter((line) => line.credit > 0)
    expect(credited.map((line) => line.number)).toContain('2500')
    expect(credited.map((line) => line.number)).not.toContain('4000')
    expect(credited.find((line) => line.number === '2500')?.credit).toBe(450_000)
  })

  it('refuses a schedule that does not come to the contract', async () => {
    const { fixture, proposal } = await proposalFixture()

    await expect(
      setBillingSchedule(fixture.ctx, proposal.id, [
        { label: 'On signing', kind: 'deposit', percentBp: 2_500 },
        { label: 'On handover', kind: 'on-completion', percentBp: 2_500 },
      ]),
    ).rejects.toThrow(/50\.00% of the contract/)
  })

  it('carries the proposal total onto the job', async () => {
    const { fixture, opportunity, proposal } = await proposalFixture()
    await sendProposal(fixture.ctx, proposal.id)
    await decideProposal(fixture.ctx, proposal.id, 'won')
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })

    const result = await convertWonOpportunity(fixture.ctx, opportunity.id)

    const { projects } = await import('@/db/schema')
    const [project] = await db.select().from(projects).where(eq(projects.id, result.projectId))

    // The proposal total wins over the earlier estimate.
    expect(project.contractValueCents).toBe(1_800_000)
  })
})

describe('proposal permissions and isolation', () => {
  it('scopes proposals to the acting company', async () => {
    const { fixture } = await proposalFixture()
    const other = await createCompanyFixture({ name: 'Other' })

    expect(await listProposals(fixture.ctx)).toHaveLength(1)
    expect(await listProposals(other.ctx)).toHaveLength(0)
  })

  it('keeps marketing out of proposal management', async () => {
    const { fixture, proposal } = await proposalFixture()
    const marketing = await addUserWithRole(fixture, 'marketing')

    await expect(sendProposal(marketing, proposal.id)).rejects.toThrow(PermissionError)
  })

  it('lets a sales user manage proposals', async () => {
    const { fixture, proposal } = await proposalFixture()
    const sales = await addUserWithRole(fixture, 'sales')

    await expect(sendProposal(sales, proposal.id)).resolves.toBeDefined()
  })
})
