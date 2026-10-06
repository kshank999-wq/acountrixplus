import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { communications } from '@/db/schema'
import {
  answerQuestion,
  askOnProposal,
  clientThread,
  threadForProposal,
  unansweredQuestions,
} from '@/modules/engagement/questions'
import { lastContactedAt, logCommunication } from '@/modules/engagement/communications'
import { organizationTimeline } from '@/modules/engagement/timeline'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal, sendProposal } from '@/modules/crm/proposals'
import { accountsNeedingAttention } from '@/modules/crm/accounts'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * A question from the client (Phase 174).
 *
 * ADR 0173's bullet-level pass found §7 asking the client link for
 * *"comments/questions"* with nothing behind it: the link tracked views and
 * took an acceptance, and a client had no way to ask anything.
 *
 * The decision this phase turns on is that a question **is a communication**,
 * not a comment. A `proposal_comments` table would have kept it off
 * `organizationTimeline` and out of `lastContactedAt` — so an account with an
 * unanswered question would have read as *quiet* on Phase 167's attention list,
 * which is the worst direction for that list to be wrong in. Two tests below
 * are about exactly that, and they are the reason for the design rather than a
 * decoration on it.
 *
 * It is also the **second unauthenticated write path** in the system.
 * `intake.ts` says of itself that it is "the only" one, which is now out of
 * date, and this file inherits that file's obligation: lean on what an attacker
 * would try rather than only the happy path.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Okonjo Builders' })
})

async function aSentProposal(opts: { send?: boolean } = {}) {
  const organization = await createOrganization(fixture.ctx, {
    name: 'Harborview Marine',
    lifecycleStage: 'prospect',
    ownerId: fixture.userId,
  })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Dock replacement',
    expectedValueCents: 2_000_000,
    stage: 'qualified',
  })
  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Dock replacement',
    items: [{ description: 'Piling', unitPriceCents: 2_000_000 }],
  })

  if (opts.send !== false) await sendProposal(fixture.ctx, proposal.id)

  return { organization, opportunity, proposal }
}

// --- The happy path, and where the question lands -------------------------

describe('a client asks, through the link', () => {
  it('records the question as an inbound exchange on the client timeline', async () => {
    const { organization, proposal } = await aSentProposal()

    const asked = await askOnProposal(proposal.publicToken, {
      body: 'Does the price include removing the old pilings? We assumed it did.',
      askerName: 'Jo Rivera',
    })

    expect(asked.ok).toBe(true)
    if (!asked.ok) return

    const [row] = await db
      .select()
      .from(communications)
      .where(eq(communications.id, asked.id))

    expect(row.direction).toBe('inbound')
    expect(row.channel).toBe('message')
    expect(row.proposalId).toBe(proposal.id)
    expect(row.organizationId).toBe(organization.id)
    // The name the client typed goes in `actor_name`, which the column's own
    // comment describes as the frozen author of an exchange.
    expect(row.actorName).toBe('Jo Rivera')
    expect(row.body).toContain('removing the old pilings')

    // And it reaches the one view that answers "what has happened with these
    // people" — the reason this is a communication and not a comment.
    const timeline = await organizationTimeline(fixture.ctx, organization.id)
    expect(timeline.some((entry) => entry.kind === 'communication')).toBe(true)
  })

  it('derives a one-line summary rather than asking the client for one', async () => {
    // `summary` is NOT NULL and its comment says why: "an entry nobody can skim
    // is noise". A client typing into a box has not been asked for a headline.
    const { proposal } = await aSentProposal()

    const asked = await askOnProposal(proposal.publicToken, {
      body: 'Can we move the start date? The yard is busy until March, so April would suit us better.',
    })
    expect(asked.ok).toBe(true)
    if (!asked.ok) return

    const [row] = await db
      .select({ summary: communications.summary })
      .from(communications)
      .where(eq(communications.id, asked.id))

    expect(row.summary).toBe('Can we move the start date?')
  })

  it('says "The client" when nobody gave a name, rather than borrowing the contact’s', async () => {
    /**
     * The fallback is deliberately not the contact's name. Writing it would
     * assert that this particular person typed the question, and the token
     * cannot establish that — anybody the link was forwarded to could have.
     */
    const { proposal } = await aSentProposal()

    const asked = await askOnProposal(proposal.publicToken, { body: 'Is VAT included?' })
    expect(asked.ok).toBe(true)
    if (!asked.ok) return

    const [row] = await db
      .select({ actorName: communications.actorName })
      .from(communications)
      .where(eq(communications.id, asked.id))

    expect(row.actorName).toBe('The client')
  })
})

// --- The reason it is a communication -------------------------------------

describe('an unanswered question makes the account not quiet', () => {
  it('counts as contact, so the attention list stops calling it silent', async () => {
    /**
     * The design decision, asserted. `lastContactedAt` reads non-internal
     * communications and drives Phase 167's `gone-quiet` ground.
     *
     * A client who asked a question today is an account somebody spoke to
     * today — and with a `proposal_comments` table it would have read as
     * nine weeks silent while a question sat unanswered on it.
     */
    const { organization, proposal } = await aSentProposal()

    // Backdate the only other exchange so the account is genuinely quiet.
    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'call',
      direction: 'outbound',
      summary: 'Sent the proposal over.',
      occurredAt: new Date(Date.now() - 70 * 86_400_000),
    })

    const before = await accountsNeedingAttention(fixture.ctx)
    expect(before.map((account) => account.organizationId)).toContain(organization.id)

    await askOnProposal(proposal.publicToken, { body: 'Does this include the permit?' })

    const spoken = await lastContactedAt(fixture.ctx, [organization.id])
    expect(spoken.get(organization.id)).toBeTruthy()

    const after = await accountsNeedingAttention(fixture.ctx)
    const found = after.find((account) => account.organizationId === organization.id)

    // No longer quiet. It may still be flagged — a proposal is outstanding,
    // which is a different and correct finding.
    expect(found?.findings.map((finding) => finding.ground) ?? []).not.toContain('gone-quiet')
  })
})

// --- What an attacker would try -------------------------------------------

describe('the second unauthenticated write path', () => {
  it('gives an unknown token the same answer as a real one it may not use', async () => {
    /**
     * A different message for "no such proposal" and "that proposal is a draft"
     * would turn this into an oracle for guessing tokens, which is the one
     * thing 32 random bytes is protecting.
     */
    const { proposal } = await aSentProposal({ send: false })

    const unknown = await askOnProposal('not-a-real-token', { body: 'Hello?' })
    const draft = await askOnProposal(proposal.publicToken, { body: 'Hello?' })

    expect(unknown.ok).toBe(false)
    expect(draft.ok).toBe(false)
    if (unknown.ok || draft.ok) return
    expect(unknown.message).toBe(draft.message)
  })

  it('writes nothing at all for a draft', async () => {
    // A draft has never been shown to anybody, so a question on one means the
    // token leaked. Refusing is not enough — recording it would put a
    // stranger's text on a client's timeline.
    const { proposal } = await aSentProposal({ send: false })

    await askOnProposal(proposal.publicToken, { body: 'Who else is bidding?' })

    const rows = await db
      .select()
      .from(communications)
      .where(eq(communications.proposalId, proposal.id))

    expect(rows).toEqual([])
  })

  it('limits one link to ten questions an hour', async () => {
    const { proposal } = await aSentProposal()

    for (let i = 0; i < 10; i++) {
      const asked = await askOnProposal(proposal.publicToken, { body: `Question ${i + 1}` })
      expect(asked.ok, `question ${i + 1}`).toBe(true)
    }

    const eleventh = await askOnProposal(proposal.publicToken, { body: 'Question 11' })

    expect(eleventh.ok).toBe(false)
    if (eleventh.ok) return
    expect(eleventh.reason).toBe('rate_limited')
  })

  it('limits per proposal rather than per address', async () => {
    /**
     * Argued rather than assumed. A client behind a corporate gateway shares an
     * address with their colleagues, so a per-address limit would silence the
     * second person at the same company to ask something. The thing worth
     * limiting is one link being used as a message queue.
     */
    const first = await aSentProposal()
    const second = await aSentProposal()

    for (let i = 0; i < 10; i++) {
      await askOnProposal(first.proposal.publicToken, { body: `Question ${i + 1}` })
    }

    expect((await askOnProposal(first.proposal.publicToken, { body: 'One more' })).ok).toBe(false)
    // The other proposal is unaffected.
    expect((await askOnProposal(second.proposal.publicToken, { body: 'Hello' })).ok).toBe(true)
  })

  it('refuses an empty question and one used as storage', async () => {
    const { proposal } = await aSentProposal()

    expect((await askOnProposal(proposal.publicToken, { body: '   ' })).ok).toBe(false)
    expect((await askOnProposal(proposal.publicToken, { body: 'x'.repeat(4001) })).ok).toBe(false)
    // And the boundary itself is allowed, so the bound is a bound and not an
    // off-by-one.
    expect((await askOnProposal(proposal.publicToken, { body: 'x'.repeat(4000) })).ok).toBe(true)
  })
})

// --- Answering ------------------------------------------------------------

describe('the business answers', () => {
  it('replies on the same thread and marks the question answered', async () => {
    const { proposal } = await aSentProposal()
    const asked = await askOnProposal(proposal.publicToken, { body: 'Does it include the permit?' })
    if (!asked.ok) return

    const answer = await answerQuestion(
      fixture.ctx,
      asked.id,
      'It does — the permit and the fee are both in line 1.',
    )

    expect(answer.direction).toBe('outbound')
    expect(answer.parentId).toBe(asked.id)
    expect(answer.proposalId).toBe(proposal.id)
    expect(answer.actorName).toBe(fixture.ctx.userName)

    const thread = await threadForProposal(fixture.ctx, proposal.id)
    expect(thread).toHaveLength(2)
    expect(thread.find((entry) => entry.id === asked.id)?.answered).toBe(true)
  })

  it('refuses to answer an answer, because the thread is two deep by design', async () => {
    /**
     * `parent_id` is a reply pointer rather than a tree, which is what §7's
     * "comments/questions" needs. A reply to a reply would claim a depth the
     * column cannot express, and a reader would have no way to order the third
     * message.
     */
    const { proposal } = await aSentProposal()
    const asked = await askOnProposal(proposal.publicToken, { body: 'Does it include the permit?' })
    if (!asked.ok) return

    const answer = await answerQuestion(fixture.ctx, asked.id, 'It does.')

    await expect(answerQuestion(fixture.ctx, answer.id, 'Thanks')).rejects.toThrow(
      /not a question from the client/i,
    )
  })

  it('refuses a role that may not manage the relationship', async () => {
    const { proposal } = await aSentProposal()
    const asked = await askOnProposal(proposal.publicToken, { body: 'Anything?' })
    if (!asked.ok) return

    const reader = await addUserWithRole(fixture, 'readonly')

    await expect(answerQuestion(reader, asked.id, 'Hello')).rejects.toThrow(/permission/i)
  })

  it('lists what nobody has answered, oldest first', async () => {
    const first = await aSentProposal()
    const second = await aSentProposal()

    const older = await askOnProposal(first.proposal.publicToken, { body: 'Asked first' })
    const newer = await askOnProposal(second.proposal.publicToken, { body: 'Asked second' })
    if (!older.ok || !newer.ok) return

    // Backdate the first so the ordering is a fact rather than an insertion
    // accident.
    await db
      .update(communications)
      .set({ occurredAt: new Date(Date.now() - 5 * 86_400_000) })
      .where(eq(communications.id, older.id))

    const waiting = await unansweredQuestions(fixture.ctx)
    expect(waiting.map((row) => row.id)).toEqual([older.id, newer.id])

    await answerQuestion(fixture.ctx, older.id, 'Answered.')

    const after = await unansweredQuestions(fixture.ctx)
    expect(after.map((row) => row.id)).toEqual([newer.id])
  })
})

// --- What the client may see ----------------------------------------------

describe('what the client’s own page shows', () => {
  it('shows the question and the answer', async () => {
    const { proposal } = await aSentProposal()
    const asked = await askOnProposal(proposal.publicToken, { body: 'Does it include the permit?' })
    if (!asked.ok) return
    await answerQuestion(fixture.ctx, asked.id, 'It does.')

    const thread = await clientThread(proposal.publicToken)

    expect(thread.map((entry) => entry.direction)).toEqual(['inbound', 'outbound'])
  })

  it('never shows an internal note about the client', async () => {
    /**
     * The one place the internal/external distinction has to hold absolutely.
     * `communications` keeps internal notes about a client on the same timeline
     * as exchanges with them — `lastContactedAt` excludes them for that reason
     * — and this is the page the client is looking at.
     */
    const { organization, opportunity, proposal } = await aSentProposal()

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      opportunityId: opportunity.id,
      channel: 'note',
      direction: 'internal',
      summary: 'They are talking to two other yards. Hold the price.',
    })

    // An internal note filed against the proposal itself, which is the case a
    // direction filter alone would catch and a proposal filter alone would not.
    await db.insert(communications).values({
      companyId: fixture.companyId,
      organizationId: organization.id,
      opportunityId: opportunity.id,
      proposalId: proposal.id,
      channel: 'message',
      direction: 'internal',
      summary: 'Margin on this one is thin.',
      actorName: 'Owner User',
    })

    const thread = await clientThread(proposal.publicToken)

    expect(thread).toEqual([])
    // And the internal notes are still on the internal thread, so nothing was
    // lost by hiding them.
    const internal = await threadForProposal(fixture.ctx, proposal.id)
    expect(internal.map((entry) => entry.direction)).toEqual(['internal'])
  })

  it('shows nothing for an unknown token rather than failing', async () => {
    expect(await clientThread('not-a-real-token')).toEqual([])
  })

  it('does not show another company’s thread for a colliding read', async () => {
    // The token is the only credential, so the read is by token and the company
    // comes from the proposal it found — not from an actor.
    const other = await createCompanyFixture({ name: 'Somebody Else Ltd' })
    const theirs = await createOrganization(other.ctx, { name: 'Their client' })
    const theirDeal = await createOpportunity(other.ctx, {
      organizationId: theirs.id,
      title: 'Their job',
      stage: 'qualified',
    })
    const theirProposal = await createProposal(other.ctx, {
      opportunityId: theirDeal.id,
      title: 'Their job',
      items: [{ description: 'Work', unitPriceCents: 100_000 }],
    })
    await sendProposal(other.ctx, theirProposal.id)
    await askOnProposal(theirProposal.publicToken, { body: 'Their question' })

    const { proposal } = await aSentProposal()
    await askOnProposal(proposal.publicToken, { body: 'Our question' })

    const ours = await clientThread(proposal.publicToken)
    expect(ours).toHaveLength(1)
    expect(ours[0].body).toBe('Our question')

    // And our own staff cannot read theirs.
    const crossed = await db
      .select()
      .from(communications)
      .where(
        and(
          eq(communications.companyId, fixture.companyId),
          eq(communications.proposalId, theirProposal.id),
        ),
      )
    expect(crossed).toEqual([])
  })
})
