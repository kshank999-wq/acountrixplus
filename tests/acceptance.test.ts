import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { opportunities, proposalAcceptances, proposalItems, proposals } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal, decideProposal, sendProposal } from '@/modules/crm/proposals'
import { acceptProposal, isAcceptable } from '@/modules/crm/acceptance'

/**
 * Proposal acceptance (spec §7).
 *
 * The second unauthenticated write path, and the one that closes deals — so
 * the tests lean on what someone would try to get away with rather than only
 * the happy path.
 */

async function sentProposalFixture(opts: { expiresOn?: string } = {}) {
  const fixture = await createCompanyFixture()
  const organization = await createOrganization(fixture.ctx, { name: 'Harborview' })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Foundation package',
    expectedValueCents: 2_000_000,
  })
  const revenue = await fixture.account('4000')

  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Foundation proposal',
    expiresOn: opts.expiresOn,
    items: [
      { description: 'Excavation', unitPriceCents: 1_800_000, chartAccountId: revenue.id },
      {
        description: 'Drainage upgrade',
        unitPriceCents: 400_000,
        isOptional: true,
        isSelected: false,
        chartAccountId: revenue.id,
      },
      {
        description: 'Landscaping',
        unitPriceCents: 250_000,
        isOptional: true,
        isSelected: false,
        chartAccountId: revenue.id,
      },
    ],
  })

  await sendProposal(fixture.ctx, proposal.id)

  const items = await db
    .select()
    .from(proposalItems)
    .where(eq(proposalItems.proposalId, proposal.id))

  return { fixture, opportunity, proposal, items }
}

const VALID = {
  signerName: 'Jo Rivera',
  signerEmail: 'jo@harborview.test',
  signerTitle: 'Director',
  signatureText: 'Jo Rivera',
  selectedItemIds: [],
  agreed: true as const,
}

describe('accepting a proposal', () => {
  it('records the acceptance and closes the deal', async () => {
    const { fixture, opportunity, proposal } = await sentProposalFixture()

    const result = await acceptProposal(proposal.publicToken, VALID, {
      ipPrefix: '203.0.113.0/24',
    })

    expect(result).toMatchObject({ ok: true, acceptedTotalCents: 1_800_000 })

    const [accepted] = await db
      .select()
      .from(proposalAcceptances)
      .where(eq(proposalAcceptances.proposalId, proposal.id))

    expect(accepted.signerName).toBe('Jo Rivera')
    expect(accepted.acceptedTotalCents).toBe(1_800_000)
    expect(accepted.ipPrefix).toBe('203.0.113.0/24')

    const [updatedProposal] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposal.id))
    expect(updatedProposal.status).toBe('won')

    const [updatedOpportunity] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))
    expect(updatedOpportunity.stage).toBe('won')
    expect(updatedOpportunity.probability).toBe(100)
  })

  it('closes the deal from whatever open stage it is in', async () => {
    // Regression: the guard matched one exact stage, so accepting a proposal
    // for a deal in negotiation closed the proposal and left the deal open.
    const { fixture, opportunity, proposal } = await sentProposalFixture()
    const { changeStage } = await import('@/modules/crm/opportunities')
    await changeStage(fixture.ctx, opportunity.id, { stage: 'negotiation' })

    const result = await acceptProposal(proposal.publicToken, VALID, {})
    expect(result.ok).toBe(true)

    const [updated] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(updated.stage).toBe('won')
    expect(updated.closedAt).not.toBeNull()
  })

  it('does not reopen a deal that was already closed', async () => {
    const { fixture, opportunity, proposal } = await sentProposalFixture()
    await (await import('@/modules/crm/opportunities')).changeStage(fixture.ctx, opportunity.id, {
      stage: 'lost',
      lossReason: 'price',
    })

    // The proposal still records the acceptance, but the closed deal stands.
    await acceptProposal(proposal.publicToken, VALID, {})

    const [updated] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunity.id))

    expect(updated.stage).toBe('lost')
  })

  it('links the acceptance to the version the client was shown', async () => {
    const { proposal } = await sentProposalFixture()
    await acceptProposal(proposal.publicToken, VALID, {})

    const [accepted] = await db
      .select()
      .from(proposalAcceptances)
      .where(eq(proposalAcceptances.proposalId, proposal.id))

    expect(accepted.proposalVersionId).not.toBeNull()
  })

  it('recomputes the total from the optional items the client selected', async () => {
    const { proposal, items } = await sentProposalFixture()
    const drainage = items.find((item) => item.description === 'Drainage upgrade')!

    const result = await acceptProposal(
      proposal.publicToken,
      { ...VALID, selectedItemIds: [drainage.id] },
      {},
    )

    // 1,800,000 base + 400,000 selected option.
    expect(result).toMatchObject({ ok: true, acceptedTotalCents: 2_200_000 })

    const [updated] = await db.select().from(proposals).where(eq(proposals.id, proposal.id))
    expect(updated.totalCents).toBe(2_200_000)
  })

  it('never trusts a total submitted by the client', async () => {
    const { proposal } = await sentProposalFixture()

    // A crafted payload claiming a lower total must not change what is owed.
    const result = await acceptProposal(
      proposal.publicToken,
      { ...VALID, acceptedTotalCents: 1, totalCents: 1, total: 1 },
      {},
    )

    expect(result).toMatchObject({ ok: true, acceptedTotalCents: 1_800_000 })
  })

  it('ignores item ids that do not belong to this proposal', async () => {
    const { proposal } = await sentProposalFixture()
    const other = await sentProposalFixture()
    const foreignItem = other.items[0]

    const result = await acceptProposal(
      proposal.publicToken,
      { ...VALID, selectedItemIds: [foreignItem.id] },
      {},
    )

    expect(result).toMatchObject({ ok: true, acceptedTotalCents: 1_800_000 })

    const [accepted] = await db
      .select()
      .from(proposalAcceptances)
      .where(eq(proposalAcceptances.proposalId, proposal.id))
    expect(accepted.selectedItemIds).toEqual([])
  })

  it('writes the client selection back onto the proposal items', async () => {
    const { proposal, items } = await sentProposalFixture()
    const drainage = items.find((item) => item.description === 'Drainage upgrade')!

    await acceptProposal(proposal.publicToken, { ...VALID, selectedItemIds: [drainage.id] }, {})

    const updated = await db
      .select()
      .from(proposalItems)
      .where(eq(proposalItems.proposalId, proposal.id))

    expect(updated.find((item) => item.id === drainage.id)?.isSelected).toBe(true)
    expect(
      updated.find((item) => item.description === 'Landscaping')?.isSelected,
    ).toBe(false)
  })
})

describe('refusing an acceptance', () => {
  it('rejects an unknown token', async () => {
    const result = await acceptProposal('not-a-real-token', VALID, {})
    expect(result).toMatchObject({ ok: false, status: 404, reason: 'not_found' })
  })

  it('rejects a signature that is not the signer\'s name', async () => {
    const { proposal } = await sentProposalFixture()

    const result = await acceptProposal(
      proposal.publicToken,
      { ...VALID, signatureText: 'Someone Else' },
      {},
    )

    expect(result).toMatchObject({ ok: false, reason: 'signature_mismatch' })
  })

  it('accepts a signature differing only in case or spacing', async () => {
    const { proposal } = await sentProposalFixture()

    const result = await acceptProposal(
      proposal.publicToken,
      { ...VALID, signatureText: '  jo rivera  ' },
      {},
    )

    expect(result.ok).toBe(true)
  })

  it('requires the agreement checkbox', async () => {
    const { proposal } = await sentProposalFixture()

    const result = await acceptProposal(proposal.publicToken, { ...VALID, agreed: false }, {})
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'invalid' })
  })

  it('rejects an empty or oversized name', async () => {
    const { proposal } = await sentProposalFixture()

    expect(
      await acceptProposal(proposal.publicToken, { ...VALID, signerName: '' }, {}),
    ).toMatchObject({ ok: false, reason: 'invalid' })

    expect(
      await acceptProposal(
        proposal.publicToken,
        { ...VALID, signerName: 'x'.repeat(500), signatureText: 'x'.repeat(500) },
        {},
      ),
    ).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('refuses to accept a draft that was never sent', async () => {
    const fixture = await createCompanyFixture()
    const organization = await createOrganization(fixture.ctx, { name: 'Harborview' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Deal',
    })
    const revenue = await fixture.account('4000')

    const draft = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Draft',
      items: [{ description: 'Work', unitPriceCents: 100_000, chartAccountId: revenue.id }],
    })

    const result = await acceptProposal(draft.publicToken, VALID, {})
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'not_acceptable' })
  })

  it('refuses a proposal already decided against', async () => {
    const { fixture, proposal } = await sentProposalFixture()
    await decideProposal(fixture.ctx, proposal.id, 'lost')

    const result = await acceptProposal(proposal.publicToken, VALID, {})
    expect(result).toMatchObject({ ok: false, reason: 'not_acceptable' })
  })

  it('refuses an expired proposal', async () => {
    const { proposal } = await sentProposalFixture({ expiresOn: '2020-01-01' })

    const result = await acceptProposal(proposal.publicToken, VALID, {})
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'expired' })
  })

  it('refuses a second acceptance', async () => {
    const { proposal } = await sentProposalFixture()

    expect((await acceptProposal(proposal.publicToken, VALID, {})).ok).toBe(true)

    const second = await acceptProposal(
      proposal.publicToken,
      { ...VALID, signerName: 'Someone Else', signatureText: 'Someone Else' },
      {},
    )

    expect(second).toMatchObject({ ok: false, status: 409 })

    const rows = await db
      .select()
      .from(proposalAcceptances)
      .where(eq(proposalAcceptances.proposalId, proposal.id))
    expect(rows).toHaveLength(1)
  })

  it('truncates an oversized user agent rather than storing it whole', async () => {
    const { proposal } = await sentProposalFixture()

    await acceptProposal(proposal.publicToken, VALID, { userAgent: 'x'.repeat(5_000) })

    const [accepted] = await db
      .select()
      .from(proposalAcceptances)
      .where(eq(proposalAcceptances.proposalId, proposal.id))

    expect(accepted.userAgent?.length).toBe(500)
  })
})

describe('acceptability', () => {
  it('is open only for sent and viewed proposals', () => {
    expect(isAcceptable({ status: 'sent', expiresOn: null })).toBe(true)
    expect(isAcceptable({ status: 'viewed', expiresOn: null })).toBe(true)
    expect(isAcceptable({ status: 'draft', expiresOn: null })).toBe(false)
    expect(isAcceptable({ status: 'won', expiresOn: null })).toBe(false)
    expect(isAcceptable({ status: 'lost', expiresOn: null })).toBe(false)
  })

  it('is closed once the expiry date has passed', () => {
    expect(isAcceptable({ status: 'sent', expiresOn: '2020-01-01' })).toBe(false)
    expect(isAcceptable({ status: 'sent', expiresOn: '2099-01-01' })).toBe(true)
  })
})
