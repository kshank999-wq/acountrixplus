import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies, organizations, proposalVersions, proposals } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { saveProfile } from '@/modules/studio/service'
import { createContact, createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal, sendProposal } from '@/modules/crm/proposals'
import { acceptProposal, acceptanceFor } from '@/modules/crm/acceptance'
import {
  describeParty,
  isParties,
  partiesFor,
  UNNAMED,
  type Parties,
} from '@/modules/crm/parties'
import { letterheadFor } from '@/modules/brand/letterhead'

/**
 * Who the agreement was between (Phase 77).
 *
 * The pure half needs no database; the rest proves the record does not move
 * when the rows it used to be resolved from do.
 */

const PROFILE = {
  legalName: 'Ridgeline Construction LLC',
  addressLine1: '412 Mill Street',
  addressLine2: 'Suite 300',
  city: 'Bellingham',
  region: 'WA',
  postalCode: '98225',
}

describe('the parties core', () => {
  const parties = partiesFor({
    letterhead: letterheadFor({ companyName: 'Ridgeline Construction', profile: PROFILE }),
    client: {
      name: 'Summit Property Group',
      addressLine1: 'Unit 4',
      city: 'Bellingham',
      region: 'WA',
      postalCode: '98226',
    },
  })

  it('leads with the registered name and keeps the trading name beside it', () => {
    expect(parties.offeredBy.names).toEqual([
      'Ridgeline Construction LLC',
      'Ridgeline Construction',
    ])
  })

  it('says a name once when there is only one', () => {
    const one = partiesFor({
      letterhead: letterheadFor({ companyName: 'Bare Co' }),
      client: { name: 'Summit Property Group' },
    })

    expect(one.offeredBy.names).toEqual(['Bare Co'])
    expect(one.offeredTo.names).toEqual(['Summit Property Group'])
  })

  it('keeps each side’s address as it stood', () => {
    expect(parties.offeredBy.address).toEqual([
      '412 Mill Street',
      'Suite 300',
      'Bellingham, WA 98225',
    ])
    expect(parties.offeredTo.address).toEqual(['Unit 4', 'Bellingham, WA 98226'])
  })

  /** A deleted opportunity should not stop a record saying what it can. */
  it('records a party with no name rather than nothing at all', () => {
    const orphan = partiesFor({
      letterhead: letterheadFor({ companyName: 'Bare Co' }),
      client: null,
    })

    expect(orphan.offeredTo.names).toEqual([UNNAMED])
    expect(orphan.offeredTo.address).toEqual([])
  })

  it('reads as a block', () => {
    expect(describeParty(parties.offeredBy)).toBe(
      'Ridgeline Construction LLC\nRidgeline Construction\n412 Mill Street\nSuite 300\nBellingham, WA 98225',
    )
  })

  /**
   * The column is `jsonb` and holds rows written by every version of this
   * module that ever ran, so a reader checks rather than assumes.
   */
  it('recognises its own shape and refuses anything else', () => {
    expect(isParties(parties)).toBe(true)
    expect(isParties(null)).toBe(false)
    expect(isParties({})).toBe(false)
    expect(isParties({ offeredBy: { names: [], address: [] }, offeredTo: parties.offeredTo })).toBe(
      false,
    )
    expect(isParties({ offeredBy: { names: ['A'] }, offeredTo: parties.offeredTo })).toBe(false)
    expect(isParties({ offeredBy: { names: [1], address: [] }, offeredTo: parties.offeredTo })).toBe(
      false,
    )
  })
})

async function acceptedProposal(fixture: Fixture) {
  const { ctx } = fixture

  await saveProfile(ctx, PROFILE)

  const organization = await createOrganization(ctx, {
    name: 'Summit Property Group',
    city: 'Bellingham',
    region: 'WA',
  })

  // `createOrganization` takes a city and a region and no street or postcode —
  // a gap of its own, and not this phase's. Set directly so the frozen record
  // has a full address to be judged on.
  await db
    .update(organizations)
    .set({ addressLine1: 'Unit 4', postalCode: '98226' })
    .where(eq(organizations.id, organization.id))

  const contact = await createContact(ctx, {
    organizationId: organization.id,
    firstName: 'Priya',
    email: 'priya@summit.test',
  })

  const opportunity = await createOpportunity(ctx, {
    organizationId: organization.id,
    title: 'Depot Road',
    primaryContactId: contact.id,
  })

  const proposal = await createProposal(ctx, {
    opportunityId: opportunity.id,
    title: 'Depot Road works',
    items: [{ description: 'Foundations', quantityMilli: 1_000, unitPriceCents: 250_000 }],
  })

  await sendProposal(ctx, proposal.id)

  const [sent] = await db
    .select({ token: proposals.publicToken })
    .from(proposals)
    .where(eq(proposals.id, proposal.id))
    .limit(1)

  const result = await acceptProposal(sent.token!, {
    signerName: 'Priya Raman',
    signerEmail: 'priya@summit.test',
    signatureText: 'Priya Raman',
    selectedItemIds: [],
    agreed: true,
  })
  expect(result.ok).toBe(true)

  return { organization, proposal }
}

describe('the record of an agreement', () => {
  it('names both parties as they were when the offer was made', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const { proposal } = await acceptedProposal(fixture)

    const acceptance = await acceptanceFor(fixture.ctx, proposal.id)

    expect(acceptance?.parties?.offeredBy.names).toEqual([
      'Ridgeline Construction LLC',
      'Ridgeline Construction',
    ])
    expect(acceptance?.parties?.offeredTo.names).toEqual(['Summit Property Group'])
    expect(acceptance?.parties?.offeredTo.address).toEqual(['Unit 4', 'Bellingham, WA 98226'])
  })

  /**
   * The defect this phase removes. Both sides are ordinary editable rows —
   * Phase 74 established that people rename a company in the Design Center, and
   * ADR 0045 made correcting a client a first-class action.
   */
  it('does not move when either party is renamed afterwards', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const { organization, proposal } = await acceptedProposal(fixture)

    await db
      .update(companies)
      .set({ name: 'Cascade Build Group' })
      .where(eq(companies.id, fixture.companyId))
    await saveProfile(fixture.ctx, { ...PROFILE, legalName: 'Cascade Build Group LLC' })
    await db
      .update(organizations)
      .set({ name: 'Summit Holdings Ltd' })
      .where(eq(organizations.id, organization.id))

    const acceptance = await acceptanceFor(fixture.ctx, proposal.id)

    expect(acceptance?.parties?.offeredBy.names).toContain('Ridgeline Construction LLC')
    expect(acceptance?.parties?.offeredBy.names).not.toContain('Cascade Build Group LLC')
    expect(acceptance?.parties?.offeredTo.names).toEqual(['Summit Property Group'])
  })

  /**
   * A version sent before the column existed has no record of its parties, and
   * says so. Reconstructing from today's rows would be a confident wrong answer
   * in exactly the case the column is for.
   */
  it('says nothing rather than guessing for an agreement made before this phase', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const { proposal } = await acceptedProposal(fixture)

    // What every row looked like before the migration.
    await db
      .update(proposalVersions)
      .set({ parties: null })
      .where(eq(proposalVersions.proposalId, proposal.id))

    const acceptance = await acceptanceFor(fixture.ctx, proposal.id)

    expect(acceptance).not.toBeNull()
    expect(acceptance?.parties).toBeNull()
  })

  it('ignores a stored value that is not a parties record', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const { proposal } = await acceptedProposal(fixture)

    await db
      .update(proposalVersions)
      .set({ parties: { offeredBy: 'Ridgeline' } as unknown as Parties })
      .where(eq(proposalVersions.proposalId, proposal.id))

    expect((await acceptanceFor(fixture.ctx, proposal.id))?.parties).toBeNull()
  })
})
