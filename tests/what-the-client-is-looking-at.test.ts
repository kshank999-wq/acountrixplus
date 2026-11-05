import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { brandKits, designDocuments, proposalVersions } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createProposal,
  proposalByToken,
  sendProposal,
  updateProposalItems,
} from '@/modules/crm/proposals'
import { createContact, createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { acceptProposal } from '@/modules/crm/acceptance'
import { clientFacingProposal } from '@/modules/crm/client-link'

/**
 * What the client is looking at (Phase 188, spec §7).
 *
 * ## The nomination did not hold, and measuring the bullet found worse
 *
 * ADR 0187 nominated §7's *"comments/questions"* on the client link, taking
 * ADR 0173's audit row at its word: *"No table, column or module."* **Phase
 * 174 built it.** The row was stale and three ADRs carried it forward without
 * re-measuring — Phase 164's rule exactly: a nomination inherited is a
 * nomination unmeasured.
 *
 * So the bullet was measured instead, the way Phase 182 measured §7's twelve
 * components. It names five things: view tracking, acceptance/e-signature,
 * comments/questions, version history, and PDF download. Four are built. The
 * fifth is not, and finding out why turned up something larger.
 *
 * ## ADR 0021's seventh decision was a heading, not a fact
 *
 * > ### Decision 7: the public link serves the snapshot, never a live render
 *
 * The paragraph under it says a client *"downloads what they were sent"*,
 * which is true: `/p/<token>/pdf` serves the issued bytes. The **heading** says
 * something larger, and `README.md` copied the heading.
 *
 * The page served live rows. Live `proposal_items`, live `discountCents` and
 * `taxCents`, live `designDocuments.blocks`, live `brandKits`. And
 * `updateProposalItems` takes `proposals:manage` and no status — the designer's
 * `isEditable` is a property of the screen, not of the system.
 *
 * So: send at one price, edit the items, and the client's page shows the new
 * price while the PDF in their inbox shows the old one. `acceptProposal`
 * recomputes from live rows — correctly refusing to trust the browser's total,
 * and trusting a server-side figure that has moved since the send — and files
 * the acceptance against the latest **version**, whose snapshot says something
 * else.
 *
 * That is the worst shape this CRM can have: what a client was sent and what
 * they accepted, disagreeing, with a signature on it.
 */

async function aSentProposal(fixture: Fixture, unitPriceCents: number) {
  const organization = await createOrganization(fixture.ctx, { name: 'Northwind Ltd' })
  const contact = await createContact(fixture.ctx, {
    organizationId: organization.id,
    firstName: 'Dana',
    lastName: 'Whitlock',
    email: 'dana@northwind.test',
  })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    primaryContactId: contact.id,
    title: 'Riverside survey',
  })

  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Riverside survey',
    items: [{ description: 'Survey', quantityMilli: 1000, unitPriceCents }],
  })

  await sendProposal(fixture.ctx, proposal.id)

  const [sent] = await db.select().from(proposalVersions).where(
    eq(proposalVersions.proposalId, proposal.id),
  )

  return { proposalId: proposal.id, token: proposal.publicToken, version: sent }
}

// ---------------------------------------------------------------------------

describe('a sent proposal that somebody edited', () => {
  it('shows the client the figures they were sent, not the new ones', async () => {
    const fixture = await createCompanyFixture()
    const { proposalId, token } = await aSentProposal(fixture, 1_000_00)

    // No status guard anywhere: `updateProposalItems` asks for
    // `proposals:manage` and nothing else. The designer hides the controls for
    // a sent proposal, which is a property of that screen and not of this.
    await updateProposalItems(fixture.ctx, proposalId, [
      { description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_200_00 },
    ])

    const view = await clientFacingProposal(token)

    expect(view).not.toBeNull()
    expect(view!.totals.totalCents).toBe(1_000_00)
    expect(view!.items[0].unitPriceCents).toBe(1_000_00)
  })

  it('accepts the figure that was sent, not the one on the record now', async () => {
    const fixture = await createCompanyFixture()
    const { proposalId, token } = await aSentProposal(fixture, 1_000_00)

    await updateProposalItems(fixture.ctx, proposalId, [
      { description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_200_00 },
    ])

    const result = await acceptProposal(token, {
      signerName: 'Dana Whitlock',
      signerEmail: 'dana@northwind.test',
      signatureText: 'Dana Whitlock',
      agreed: true,
      selectedItemIds: [],
    })

    expect(result.ok).toBe(true)

    /*
      The sharpest consequence. `acceptProposal` refuses to trust the browser's
      total — correctly — and then trusted a server-side figure that had moved
      since the send. The acceptance was filed against the latest version,
      whose snapshot said something else, so the signature and the document it
      signs disagreed and nothing reported it.
    */
    expect(result.ok && result.acceptedTotalCents).toBe(1_000_00)
  })

  it('does not let the designer restyle a document the client is reading', async () => {
    const fixture = await createCompanyFixture()
    const { proposalId, token } = await aSentProposal(fixture, 1_000_00)

    const before = await clientFacingProposal(token)

    const [document] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.proposalId, proposalId))

    if (document) {
      await db
        .update(designDocuments)
        .set({ blocks: [{ id: 'x', type: 'heading', text: 'Rewritten', level: 1, align: 'left' }] })
        .where(eq(designDocuments.id, document.id))
    }

    await db
      .update(brandKits)
      .set({ primaryColor: '#ff0000' })
      .where(eq(brandKits.companyId, fixture.companyId))

    const after = await clientFacingProposal(token)

    /*
      Phase 21's own argument, which it made about the PDF and not about the
      page: *"restyling proposals in June silently restyled every proposal ever
      sent."* It was still true of the thing a client actually opens.
    */
    expect(after!.blocks).toEqual(before!.blocks)
    expect(after!.brand).toEqual(before!.brand)
  })
})

describe('a proposal sent before any of this existed', () => {
  it('still renders, from the live record, and says so', async () => {
    const fixture = await createCompanyFixture()
    const { token, version } = await aSentProposal(fixture, 1_000_00)

    /*
      A version written before Phase 188 has figures in its snapshot and no
      document. Falling back to the live record is the only thing that can be
      done with it, and the view says which it is rather than pretending —
      `fromSnapshot` is false, and the one caller that matters, the acceptance,
      reads the same flag.
    */
    const snapshot = version.snapshot as Record<string, unknown>
    await db
      .update(proposalVersions)
      .set({ snapshot: { ...snapshot, document: undefined, brand: undefined } })
      .where(eq(proposalVersions.id, version.id))

    const view = await clientFacingProposal(token)

    expect(view).not.toBeNull()
    expect(view!.documentFromSnapshot).toBe(false)
  })

  it('has nothing to serve for a proposal nobody has sent', async () => {
    const fixture = await createCompanyFixture()

    const organization = await createOrganization(fixture.ctx, { name: 'Northwind Ltd' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Draft only',
    })
    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Draft only',
      items: [{ description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_000_00 }],
    })

    /*
      Null, because the question this function answers is "what was this client
      sent" and the answer is nothing. A draft has no version.

      `proposalByToken` is **not** null, and that is a finding rather than an
      oversight on this function's part: a draft's public token serves the full
      page today, to anybody holding it. The token is 24 random bytes and only
      reaches a client on send, so it is not a practical exposure — and the
      designer's *"Preview client view"* link depends on exactly this
      behaviour, which is why Phase 188 states it rather than closing it
      without a replacement. Asserted so the next person meets the fact rather
      than discovering it.
    */
    expect(await clientFacingProposal(proposal.publicToken)).toBeNull()
    expect(await proposalByToken(proposal.publicToken)).not.toBeNull()
  })
})
