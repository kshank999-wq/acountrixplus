import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customers, opportunities, organizations, projects } from '@/db/schema'
import { addUserWithRole, createCompanyFixture } from './helpers'
import {
  InvalidStageTransitionError,
  OPEN_STAGES,
  STAGE_PROBABILITY,
  isTerminal,
  requiresLossReason,
  stageLabel,
  weightedValueCents,
} from '@/modules/crm/pipeline'
import {
  activityFor,
  changeStage,
  createContact,
  createOpportunity,
  createOrganization,
  listOpportunities,
  reopenOpportunity,
  updateOpportunity,
} from '@/modules/crm/opportunities'
import { convertWonOpportunity, listProjects } from '@/modules/crm/conversion'
import {
  basisPoints,
  breakdownBy,
  lossReasons,
  pipelineValue,
  winLossSummary,
} from '@/modules/crm/analytics'
import { PermissionError } from '@/modules/permissions'

/** Pipeline rules (spec §6). */
describe('pipeline stages', () => {
  it('marks won, lost, and dormant as terminal', () => {
    expect(isTerminal('won')).toBe(true)
    expect(isTerminal('lost')).toBe(true)
    expect(isTerminal('dormant')).toBe(true)
    expect(isTerminal('negotiation')).toBe(false)
  })

  it('excludes terminal stages from the open set', () => {
    expect(OPEN_STAGES).not.toContain('won')
    expect(OPEN_STAGES).toContain('new_inquiry')
    expect(OPEN_STAGES).toHaveLength(7)
  })

  it('requires a loss reason for lost and dormant only', () => {
    expect(requiresLossReason('lost')).toBe(true)
    expect(requiresLossReason('dormant')).toBe(true)
    expect(requiresLossReason('won')).toBe(false)
  })

  it('weights value by probability in whole cents', () => {
    expect(weightedValueCents(100_000, 50)).toBe(50_000)
    // Rounds rather than leaving a fraction of a cent.
    expect(weightedValueCents(100_000, 33)).toBe(33_000)
    expect(weightedValueCents(99_999, 33)).toBe(33_000)
  })

  it('gives won certainty and lost zero', () => {
    expect(STAGE_PROBABILITY.won).toBe(100)
    expect(STAGE_PROBABILITY.lost).toBe(0)
  })

  it('labels stages for display', () => {
    expect(stageLabel('new_inquiry')).toBe('New inquiry')
    expect(stageLabel('follow_up')).toBe('Follow-up')
  })
})

async function opportunityFixture(overrides: { expectedValueCents?: number } = {}) {
  const fixture = await createCompanyFixture()
  const organization = await createOrganization(fixture.ctx, {
    name: 'Harborview Development',
    industry: 'Real estate',
    region: 'WA',
    source: 'referral',
  })
  const contact = await createContact(fixture.ctx, {
    organizationId: organization.id,
    firstName: 'Jo',
    lastName: 'Rivera',
    email: 'jo@harborview.test',
  })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    primaryContactId: contact.id,
    title: 'Foundation package',
    expectedValueCents: overrides.expectedValueCents ?? 2_500_000,
    source: 'referral',
  })

  return { fixture, organization, contact, opportunity }
}

describe('opportunities', () => {
  it('creates an opportunity at new inquiry with the stage default probability', async () => {
    const { opportunity } = await opportunityFixture()

    expect(opportunity.stage).toBe('new_inquiry')
    expect(opportunity.probability).toBe(10)
    expect(opportunity.expectedValueCents).toBe(2_500_000)
  })

  it('records stage changes in the sales activity history', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await changeStage(fixture.ctx, opportunity.id, { stage: 'qualified' })
    const activity = await activityFor(fixture.ctx, opportunity.id)

    expect(activity.some((a) => a.kind === 'stage_change')).toBe(true)
    expect(activity.find((a) => a.kind === 'stage_change')?.summary).toBe(
      'New inquiry → Qualified',
    )
  })

  it('allows moving backwards, because deals stall', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await changeStage(fixture.ctx, opportunity.id, { stage: 'negotiation' })
    await expect(
      changeStage(fixture.ctx, opportunity.id, { stage: 'follow_up' }),
    ).resolves.toBeDefined()
  })

  it('refuses to change the stage of a closed opportunity', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })
    await expect(
      changeStage(fixture.ctx, opportunity.id, { stage: 'negotiation' }),
    ).rejects.toThrow(InvalidStageTransitionError)
  })

  it('requires a loss reason when closing as lost', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await expect(changeStage(fixture.ctx, opportunity.id, { stage: 'lost' })).rejects.toThrow(
      /needs a loss reason/i,
    )

    await expect(
      changeStage(fixture.ctx, opportunity.id, { stage: 'lost', lossReason: 'price' }),
    ).resolves.toBeDefined()
  })

  it('sets probability to certainty on win and zero on loss', async () => {
    const { fixture, opportunity } = await opportunityFixture()
    const second = await createOpportunity(fixture.ctx, {
      organizationId: opportunity.organizationId,
      title: 'Second deal',
      expectedValueCents: 100_000,
    })

    const won = await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })
    const lost = await changeStage(fixture.ctx, second.id, {
      stage: 'lost',
      lossReason: 'competitor',
    })

    expect(won.probability).toBe(100)
    expect(won.closedAt).not.toBeNull()
    expect(lost.probability).toBe(0)
    expect(lost.lossReason).toBe('competitor')
  })

  it('clears the loss reason when reopened', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await changeStage(fixture.ctx, opportunity.id, { stage: 'lost', lossReason: 'timing' })
    const reopened = await reopenOpportunity(fixture.ctx, opportunity.id, 'follow_up')

    expect(reopened.stage).toBe('follow_up')
    expect(reopened.lossReason).toBeNull()
    expect(reopened.closedAt).toBeNull()
  })

  it('refuses to reopen into another closed stage', async () => {
    const { fixture, opportunity } = await opportunityFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'lost', lossReason: 'price' })

    await expect(reopenOpportunity(fixture.ctx, opportunity.id, 'won')).rejects.toThrow(
      /not another closed one/i,
    )
  })

  it('tracks the stage default probability as the deal advances', async () => {
    // Regression: the probability used to stay at whatever the opportunity was
    // created with, so a deal in negotiation was forecast at 10%.
    const { fixture, opportunity } = await opportunityFixture()
    expect(opportunity.probability).toBe(10)

    const qualified = await changeStage(fixture.ctx, opportunity.id, { stage: 'qualified' })
    expect(qualified.probability).toBe(25)

    const negotiating = await changeStage(fixture.ctx, opportunity.id, { stage: 'negotiation' })
    expect(negotiating.probability).toBe(80)
  })

  it('stops tracking the stage once the probability is set by hand', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await updateOpportunity(fixture.ctx, opportunity.id, { probability: 45 })
    const moved = await changeStage(fixture.ctx, opportunity.id, { stage: 'negotiation' })

    // The salesperson's judgement beats the stage default.
    expect(moved.probability).toBe(45)
  })

  it('lets closing override even a hand-set probability', async () => {
    const { fixture, opportunity } = await opportunityFixture()
    await updateOpportunity(fixture.ctx, opportunity.id, { probability: 45 })

    const won = await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })
    // A win is a certainty, not an estimate.
    expect(won.probability).toBe(100)
  })

  it('rejects a probability outside 0 to 100', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await expect(
      updateOpportunity(fixture.ctx, opportunity.id, { probability: 150 }),
    ).rejects.toThrow(/between 0 and 100/i)
  })
})

/** Marketing eligibility captured at close (spec §6, §10). */
describe('marketing eligibility on close', () => {
  it('marks a lost deal eligible when the contact consented', async () => {
    const fixture = await createCompanyFixture()
    const organization = await createOrganization(fixture.ctx, { name: 'Consenting Co' })
    const contact = await createContact(fixture.ctx, {
      organizationId: organization.id,
      email: 'ok@consenting.test',
      emailConsent: 'subscribed',
    })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      primaryContactId: contact.id,
      title: 'Deal',
    })

    const lost = await changeStage(fixture.ctx, opportunity.id, {
      stage: 'lost',
      lossReason: 'price',
    })
    expect(lost.marketingEligible).toBe(true)
  })

  it('does not treat unknown consent as permission', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    const lost = await changeStage(fixture.ctx, opportunity.id, {
      stage: 'lost',
      lossReason: 'price',
    })
    // The fixture contact never opted in.
    expect(lost.marketingEligible).toBe(false)
  })

  it('respects suppression over consent', async () => {
    const fixture = await createCompanyFixture()
    const organization = await createOrganization(fixture.ctx, { name: 'Suppressed Co' })
    const contact = await createContact(fixture.ctx, {
      organizationId: organization.id,
      email: 'stop@suppressed.test',
      emailConsent: 'subscribed',
    })

    const { contacts } = await import('@/db/schema')
    await db
      .update(contacts)
      .set({ suppressedAt: new Date() })
      .where(eq(contacts.id, contact.id))

    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      primaryContactId: contact.id,
      title: 'Deal',
    })
    const lost = await changeStage(fixture.ctx, opportunity.id, {
      stage: 'lost',
      lossReason: 'price',
    })

    expect(lost.marketingEligible).toBe(false)
  })
})

/** Won → client and job (spec §6). */
describe('conversion', () => {
  it('creates a client and a job from a won opportunity', async () => {
    const { fixture, organization, opportunity } = await opportunityFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })

    const result = await convertWonOpportunity(fixture.ctx, opportunity.id)

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, result.customerId))
    const [project] = await db.select().from(projects).where(eq(projects.id, result.projectId))

    expect(customer.name).toBe('Harborview Development')
    // The accounting customer links back to the CRM organization.
    expect(customer.organizationId).toBe(organization.id)
    expect(project.code).toBe('JOB-1001')
    expect(project.contractValueCents).toBe(2_500_000)
  })

  it('promotes the organization to an active client', async () => {
    const { fixture, organization, opportunity } = await opportunityFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })
    await convertWonOpportunity(fixture.ctx, opportunity.id)

    const [updated] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organization.id))

    expect(updated.lifecycleStage).toBe('active_client')
  })

  it('refuses to convert an opportunity that has not been won', async () => {
    const { fixture, opportunity } = await opportunityFixture()

    await expect(convertWonOpportunity(fixture.ctx, opportunity.id)).rejects.toThrow(
      /only a won opportunity/i,
    )
  })

  it('is idempotent — converting twice does not duplicate the client', async () => {
    const { fixture, opportunity } = await opportunityFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })

    const first = await convertWonOpportunity(fixture.ctx, opportunity.id)
    const second = await convertWonOpportunity(fixture.ctx, opportunity.id)

    expect(second.alreadyConverted).toBe(true)
    expect(second.customerId).toBe(first.customerId)
    expect(second.projectId).toBe(first.projectId)

    expect(await listProjects(fixture.ctx)).toHaveLength(1)
  })

  it('reuses an existing customer for a repeat client', async () => {
    const { fixture, organization, opportunity } = await opportunityFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })
    const first = await convertWonOpportunity(fixture.ctx, opportunity.id)

    const second = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Second phase',
      expectedValueCents: 900_000,
    })
    await changeStage(fixture.ctx, second.id, { stage: 'won' })
    const secondResult = await convertWonOpportunity(fixture.ctx, second.id)

    // One client, two jobs.
    expect(secondResult.customerId).toBe(first.customerId)
    expect(await listProjects(fixture.ctx)).toHaveLength(2)
  })

  it('records the conversion on the opportunity', async () => {
    const { fixture, opportunity } = await opportunityFixture()
    await changeStage(fixture.ctx, opportunity.id, { stage: 'won' })
    const result = await convertWonOpportunity(fixture.ctx, opportunity.id)

    const [updated] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(updated.convertedCustomerId).toBe(result.customerId)
    expect(updated.convertedProjectId).toBe(result.projectId)
  })
})

/** Win/loss analytics (spec §9). */
describe('analytics', () => {
  it('computes ratios in exact basis points', () => {
    expect(basisPoints(1, 2)).toBe(5_000)
    expect(basisPoints(2, 3)).toBe(6_667)
    // No base means no rate, not a division by zero.
    expect(basisPoints(0, 0)).toBe(0)
  })

  async function analyticsFixture() {
    const fixture = await createCompanyFixture()
    const org = await createOrganization(fixture.ctx, {
      name: 'Acme',
      industry: 'Construction',
      region: 'WA',
    })

    const make = async (title: string, value: number, source: string) =>
      createOpportunity(fixture.ctx, {
        organizationId: org.id,
        title,
        expectedValueCents: value,
        source,
      })

    const wonA = await make('Won A', 1_000_000, 'referral')
    const wonB = await make('Won B', 500_000, 'website')
    const lostA = await make('Lost A', 800_000, 'website')
    const open = await make('Open', 300_000, 'referral')

    await changeStage(fixture.ctx, wonA.id, { stage: 'won' })
    await changeStage(fixture.ctx, wonB.id, { stage: 'won' })
    await changeStage(fixture.ctx, lostA.id, { stage: 'lost', lossReason: 'price' })
    await changeStage(fixture.ctx, open.id, { stage: 'negotiation' })

    return { fixture, org }
  }

  it('summarizes win rate by count and by value', async () => {
    const { fixture } = await analyticsFixture()
    const summary = await winLossSummary(fixture.ctx)

    expect(summary.wonCount).toBe(2)
    expect(summary.lostCount).toBe(1)
    expect(summary.openCount).toBe(1)
    expect(summary.wonValueCents).toBe(1_500_000)

    // 2 of 3 decided.
    expect(summary.winRateByCountBp).toBe(6_667)
    // 1,500,000 of 2,300,000 by value.
    expect(summary.winRateByValueBp).toBe(6_522)
    expect(summary.averageWonValueCents).toBe(750_000)
  })

  it('weights the forecast by probability', async () => {
    const { fixture } = await analyticsFixture()
    const summary = await winLossSummary(fixture.ctx)

    // The one open deal sits at negotiation: 300,000 × 80%.
    expect(summary.openValueCents).toBe(300_000)
    expect(summary.forecastValueCents).toBe(240_000)
  })

  it('keeps dormant deals out of the win rate denominator', async () => {
    const { fixture } = await analyticsFixture()
    const org = (await db.select().from(organizations).limit(1))[0]

    const dormant = await createOpportunity(fixture.ctx, {
      organizationId: org.id,
      title: 'Went quiet',
      expectedValueCents: 999_999,
    })
    await changeStage(fixture.ctx, dormant.id, {
      stage: 'dormant',
      lossReason: 'no_response',
    })

    const summary = await winLossSummary(fixture.ctx)
    expect(summary.dormantCount).toBe(1)
    // Unchanged: a deal that went quiet was never decided.
    expect(summary.winRateByCountBp).toBe(6_667)
  })

  it('breaks performance down by source', async () => {
    const { fixture } = await analyticsFixture()
    const rows = await breakdownBy(fixture.ctx, 'source')

    const referral = rows.find((r) => r.key === 'referral')
    const website = rows.find((r) => r.key === 'website')

    expect(referral?.wonCount).toBe(1)
    expect(referral?.wonValueCents).toBe(1_000_000)
    // Website: one won, one lost.
    expect(website?.winRateBp).toBe(5_000)
  })

  it('reports loss reasons and re-engagement eligibility', async () => {
    const { fixture } = await analyticsFixture()
    const report = await lossReasons(fixture.ctx)

    expect(report.totalCount).toBe(1)
    expect(report.rows[0].reason).toBe('price')
    expect(report.rows[0].shareBp).toBe(10_000)
    // No consent was given, so nothing is re-engageable.
    expect(report.reEngageableCount).toBe(0)
  })

  it('reports open pipeline by stage', async () => {
    const { fixture } = await analyticsFixture()
    const rows = await pipelineValue(fixture.ctx)

    expect(rows).toHaveLength(1)
    expect(rows[0].stage).toBe('negotiation')
    expect(rows[0].weightedCents).toBe(240_000)
  })
})

/** Tenant isolation across the CRM (spec §14, §19). */
describe('crm tenant isolation', () => {
  it('scopes opportunities to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const org = await createOrganization(alpha.ctx, { name: 'Alpha Client' })
    await createOpportunity(alpha.ctx, { organizationId: org.id, title: 'Alpha deal' })

    expect(await listOpportunities(alpha.ctx)).toHaveLength(1)
    expect(await listOpportunities(beta.ctx)).toHaveLength(0)
  })

  it('refuses to create an opportunity against another company\'s organization', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const betaOrg = await createOrganization(beta.ctx, { name: 'Beta Client' })

    await expect(
      createOpportunity(alpha.ctx, { organizationId: betaOrg.id, title: 'Cross-tenant' }),
    ).rejects.toThrow(/not found/i)
  })

  it('scopes analytics to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const org = await createOrganization(alpha.ctx, { name: 'Alpha Client' })
    const opportunity = await createOpportunity(alpha.ctx, {
      organizationId: org.id,
      title: 'Deal',
      expectedValueCents: 100_000,
    })
    await changeStage(alpha.ctx, opportunity.id, { stage: 'won' })

    expect((await winLossSummary(alpha.ctx)).wonCount).toBe(1)
    expect((await winLossSummary(beta.ctx)).wonCount).toBe(0)
  })
})

/** Role boundaries (spec §14). */
describe('crm permissions', () => {
  it('lets a sales user manage the pipeline', async () => {
    const fixture = await createCompanyFixture()
    const sales = await addUserWithRole(fixture, 'sales')

    const org = await createOrganization(sales, { name: 'Sales-created Co' })
    await expect(
      createOpportunity(sales, { organizationId: org.id, title: 'Deal' }),
    ).resolves.toBeDefined()
  })

  it('gives marketing read access but not pipeline management', async () => {
    const fixture = await createCompanyFixture()
    const marketing = await addUserWithRole(fixture, 'marketing')

    await expect(listOpportunities(marketing)).resolves.toBeDefined()
    await expect(
      createOrganization(marketing, { name: 'Should not be allowed' }),
    ).rejects.toThrow(PermissionError)
  })

  it('keeps a bookkeeper out of pipeline management', async () => {
    const fixture = await createCompanyFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await expect(
      createOrganization(bookkeeper, { name: 'Should not be allowed' }),
    ).rejects.toThrow(PermissionError)
  })
})
