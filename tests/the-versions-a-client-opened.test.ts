import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { proposalViews } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createProposal,
  recordView,
  sendProposal,
  updateProposalItems,
} from '@/modules/crm/proposals'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { clientVersionHistory, versionForClient } from '@/modules/crm/client-link'

/**
 * The versions a client opened (Phase 189, spec §7).
 *
 * The last unbuilt item of §7's client-link bullet. Phase 188 measured the
 * bullet item by item — view tracking, acceptance, comments/questions, version
 * history, PDF download — and found four of five built, with the fourth
 * showing nothing: the company sees a version list in its own workspace, and
 * the client sees a single *Download the PDF* with no sign the document was
 * ever revised.
 *
 * ## The decision this phase is mostly about
 *
 * What may a client see of a **superseded** version?
 *
 * Showing every earlier PDF is one answer and it is wrong in a specific way: a
 * company that sent a price by mistake and corrected it an hour later would be
 * handing the client the mistake, and on a link the client may never have
 * opened in that hour. Showing nothing is what the page does today and is what
 * §7 asks to change.
 *
 * `proposal_views` already records **when the client opened the link**, and
 * each version is the document that link served between its `sentAt` and the
 * next one's. So the rule is evidence rather than policy:
 *
 * > A client may re-read a version they demonstrably opened.
 *
 * Every version is **listed** with its date, because knowing a document was
 * revised is what "version history" means and discloses no figures. A version
 * they opened is also downloadable and carries its total. One they never
 * opened is a date and nothing else.
 */

async function aProposal(fixture: Fixture, unitPriceCents: number) {
  const organization = await createOrganization(fixture.ctx, { name: 'Northwind Ltd' })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Riverside survey',
  })

  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Riverside survey',
    items: [{ description: 'Survey', quantityMilli: 1000, unitPriceCents }],
  })

  return proposal
}

/** A view at a chosen moment, which is the evidence the rule turns on. */
async function viewedAt(fixture: Fixture, proposalId: string, at: Date) {
  const [view] = await db
    .insert(proposalViews)
    .values({ companyId: fixture.companyId, proposalId })
    .returning({ id: proposalViews.id })

  await db.update(proposalViews).set({ viewedAt: at }).where(eq(proposalViews.id, view.id))
}

// ---------------------------------------------------------------------------

describe('what the history shows', () => {
  it('lists every version, so a client knows the document was revised', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    await sendProposal(fixture.ctx, proposal.id)
    await updateProposalItems(fixture.ctx, proposal.id, [
      { description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_200_00 },
    ])
    await sendProposal(fixture.ctx, proposal.id)

    const history = await clientVersionHistory(proposal.publicToken)

    // Both, newest first. A list that hid the earlier one would be a version
    // history that cannot say there was a version.
    expect(history.map((entry) => entry.versionNumber)).toEqual([2, 1])
    expect(history[0].isCurrent).toBe(true)
    expect(history[1].isCurrent).toBe(false)
  })

  it('tells a client nothing about a version they never opened', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    await sendProposal(fixture.ctx, proposal.id)
    await updateProposalItems(fixture.ctx, proposal.id, [
      { description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_200_00 },
    ])
    await sendProposal(fixture.ctx, proposal.id)

    const [, first] = await clientVersionHistory(proposal.publicToken)

    /*
      The case the rule exists for: a price sent by mistake and corrected
      before anybody looked. The client learns the document was revised and
      when, which is honest, and is not handed the figure they never saw.
    */
    expect(first.wasOpened).toBe(false)
    expect(first.canDownload).toBe(false)
    expect(first.totalCents).toBeNull()
    expect(first.sentAt).toBeInstanceOf(Date)
  })

  it('lets a client re-read a version they did open', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    await sendProposal(fixture.ctx, proposal.id)
    await recordView(proposal.publicToken, {})

    await updateProposalItems(fixture.ctx, proposal.id, [
      { description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_200_00 },
    ])
    await sendProposal(fixture.ctx, proposal.id)

    const [, first] = await clientVersionHistory(proposal.publicToken)

    // They read it at the time; withholding it now would be pretending
    // something was not sent that was.
    expect(first.wasOpened).toBe(true)
    expect(first.canDownload).toBe(true)
    expect(first.totalCents).toBe(1_000_00)
  })

  it('counts a view against the version that was live when it happened', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    await sendProposal(fixture.ctx, proposal.id)
    await updateProposalItems(fixture.ctx, proposal.id, [
      { description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_200_00 },
    ])
    await sendProposal(fixture.ctx, proposal.id)

    // A view after the second send belongs to the second version, not the
    // first — the window is `sentAt` to the next version's `sentAt`, and an
    // implementation that only asked "has this proposal ever been viewed"
    // would unlock every earlier price on the first visit.
    await recordView(proposal.publicToken, {})

    const history = await clientVersionHistory(proposal.publicToken)

    expect(history[0].wasOpened).toBe(true)
    expect(history[1].wasOpened).toBe(false)
  })

  it('attributes a view before any send to nothing', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    /*
      The author's own "Preview client view" on a draft, which Phase 188
      recorded as a live behaviour: it writes a view row. Attributing it to the
      first version would unlock a version on the strength of the seller having
      looked at it.
    */
    await recordView(proposal.publicToken, {})
    await sendProposal(fixture.ctx, proposal.id)
    await updateProposalItems(fixture.ctx, proposal.id, [
      { description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_200_00 },
    ])
    await sendProposal(fixture.ctx, proposal.id)

    const [, first] = await clientVersionHistory(proposal.publicToken)
    expect(first.wasOpened).toBe(false)
  })

  it('has one entry and no history for a proposal sent once', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)
    await sendProposal(fixture.ctx, proposal.id)

    const history = await clientVersionHistory(proposal.publicToken)

    // The common case. A page that announced "1 version" on every proposal
    // would be noise, so the caller is given the list and decides.
    expect(history).toHaveLength(1)
    expect(history[0].isCurrent).toBe(true)
  })

  it('is empty for a proposal nobody has sent', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    expect(await clientVersionHistory(proposal.publicToken)).toEqual([])
    expect(await clientVersionHistory('not-a-token')).toEqual([])
  })
})

describe('what a download is allowed to serve', () => {
  it('serves the current version without needing a view', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)
    await sendProposal(fixture.ctx, proposal.id)

    // It is the page they are already looking at.
    const current = await versionForClient(proposal.publicToken, 1)
    expect(current).not.toBeNull()
    expect(current!.versionNumber).toBe(1)
  })

  it('refuses a superseded version the client never opened', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    await sendProposal(fixture.ctx, proposal.id)
    await sendProposal(fixture.ctx, proposal.id)

    /*
      The assertion that makes the rule real. One function answers "may this
      client read this version", and the route and the page both call it —
      because two readers of that question is how Phase 188 happened.
    */
    expect(await versionForClient(proposal.publicToken, 1)).toBeNull()
  })

  it('serves a superseded version the client did open', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    await sendProposal(fixture.ctx, proposal.id)
    await recordView(proposal.publicToken, {})
    await sendProposal(fixture.ctx, proposal.id)

    const earlier = await versionForClient(proposal.publicToken, 1)
    expect(earlier?.versionNumber).toBe(1)
  })

  it('refuses a version of somebody else\'s proposal', async () => {
    const mine = await createCompanyFixture({ name: 'Mine' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })

    const ours = await aProposal(mine, 1_000_00)
    const other = await aProposal(theirs, 9_000_00)
    await sendProposal(mine.ctx, ours.id)
    await sendProposal(theirs.ctx, other.id)

    // The version number is a small integer a client can type. It is resolved
    // under the proposal the token names and nowhere else, so guessing one
    // reaches the asker's own proposal or nothing.
    const found = await versionForClient(ours.publicToken, 1)
    expect(found?.proposalId).toBe(ours.id)

    expect(await versionForClient(ours.publicToken, 99)).toBeNull()
  })

  it('does not treat a view of one proposal as a view of another', async () => {
    const fixture = await createCompanyFixture()
    const watched = await aProposal(fixture, 1_000_00)
    const other = await aProposal(fixture, 2_000_00)

    await sendProposal(fixture.ctx, watched.id)
    await sendProposal(fixture.ctx, other.id)

    // Views are per proposal, and a query that forgot that would unlock one
    // client's history with another client's reading.
    await recordView(other.publicToken, {})
    await sendProposal(fixture.ctx, watched.id)

    expect(await versionForClient(watched.publicToken, 1)).toBeNull()
  })
})

describe('the window a view falls in', () => {
  it('belongs to the version live at that moment, at either edge', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, 1_000_00)

    await sendProposal(fixture.ctx, proposal.id)
    const [v1] = await clientVersionHistory(proposal.publicToken)

    await sendProposal(fixture.ctx, proposal.id)
    const [v2] = await clientVersionHistory(proposal.publicToken)

    /*
      A view exactly at a version's `sentAt` is a view of that version, and one
      a millisecond before it belongs to the one before. Half-open rather than
      closed at both ends, because a closed interval would let one view unlock
      two versions — and the two sends in a test are milliseconds apart, which
      is precisely when an off-by-one shows.
    */
    await viewedAt(fixture, proposal.id, v2.sentAt)
    expect((await clientVersionHistory(proposal.publicToken))[0].wasOpened).toBe(true)
    expect((await clientVersionHistory(proposal.publicToken))[1].wasOpened).toBe(false)

    await viewedAt(fixture, proposal.id, new Date(v2.sentAt.getTime() - 1))
    const after = await clientVersionHistory(proposal.publicToken)
    expect(after[1].wasOpened).toBe(true)
    expect(after[1].versionNumber).toBe(v1.versionNumber)
  })
})
