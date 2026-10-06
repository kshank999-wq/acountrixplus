/**
 * A question from the client (Phase 174, spec §7).
 *
 * §7 asks the client-facing proposal link for *"view tracking,
 * acceptance/e-signature integration, comments/questions, version history, and
 * PDF download"*. ADR 0173's bullet-level pass measured the middle one as
 * absent: the link tracked views and took an acceptance, and a client had no way
 * to ask anything through it.
 *
 * ## It is a communication, not a comment
 *
 * The obvious shape is a `proposal_comments` table. A question from a client is
 * **one exchange with somebody outside the company**, which is exactly what
 * `communications` holds, and putting it anywhere else costs two things:
 *
 *  - **The client timeline.** `organizationTimeline` merges communications,
 *    tasks and opportunity activity. A separate table would be invisible there,
 *    so "what has happened with these people" would omit the one thing the
 *    client actually said.
 *  - **The attention list.** `lastContactedAt` reads non-internal
 *    communications and drives Phase 167's `gone-quiet` ground. A client who
 *    asked nine days ago and got no answer is *precisely* a neglected account,
 *    and with a separate table that account would read as quiet while the
 *    question sat there. That is the worst direction for that list to be wrong
 *    in.
 *
 * So asking is an **inbound** communication and answering is an **outbound**
 * one, and both land where every other exchange with this client does.
 *
 * ## The second unauthenticated write path in the system
 *
 * `intake.ts` was the first and said so — *"the only unauthenticated write path
 * in the system"* — and this module inherits that file's obligation rather than
 * its claim. The count is in `modules/tenancy/public-writes` now, because four
 * sentences across four files had each kept it and each gone stale. There are
 * five, two of which nobody had written down until the register's scan found
 * them.
 *
 * What stands between this and abuse:
 *
 *  - **The token is the credential.** 32 random bytes, and `newPublicToken`'s
 *    comment says why: "the client link must not be guessable from another". No
 *    token, no proposal, no write.
 *  - **A draft takes no questions.** Asking is only possible once the proposal
 *    has been sent, because a draft has never been shown to anybody and a
 *    question on one would mean the token leaked.
 *  - **A rate limit per proposal**, not per IP. A client behind a corporate
 *    gateway shares an address with their colleagues, and the thing worth
 *    limiting is one link being used as a message queue.
 *  - **Length bounds**, so the body cannot be used as storage.
 *
 * What deliberately does *not* stand between it and abuse: a honeypot.
 * `intake.ts` has one because a public form is crawled by bots that fill every
 * field they find. A proposal link is not published anywhere and is not
 * discoverable, so a honeypot here would be a control with nothing to catch —
 * and Phase 160's lesson is that a control which cannot fire is worse than
 * none, because the register says it is there.
 */

import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { communications, contacts, opportunities, proposals } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import { DomainError, Refusal } from '@/modules/errors'

/** The longest a client's question may be. */
const MAX_BODY = 4000

/** Questions allowed on one proposal per hour. */
const HOURLY_LIMIT = 10

export class QuestionError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'QuestionError'
  }
}

/** One line for a list, derived rather than asked for. */
function summaryOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  /*
    `summary` is `NOT NULL` on `communications` and its comment says why: "an
    entry nobody can skim is noise". A client typing into a box has not been
    asked for a one-line version, so it is taken from the first sentence rather
    than demanded — and truncated to the column's own 300-character rule.
  */
  const firstSentence = flat.split(/(?<=[.?!])\s/)[0] ?? flat
  const line = firstSentence.length > 0 ? firstSentence : flat
  return line.length > 280 ? `${line.slice(0, 277)}…` : line
}

export type AskResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'not_sent' | 'rate_limited' | 'empty'; message: string }

/**
 * Records a question asked through the client link.
 *
 * Takes no actor, like `recordView`: the viewer is the client, not a user of
 * the system. It returns a result rather than throwing, because every refusal
 * here is a sentence a client reads on a public page and `messageFor` is not
 * reachable from there.
 */
export async function askOnProposal(
  publicToken: string,
  input: { body: string; askerName?: string | null },
): Promise<AskResult> {
  const body = input.body.trim()

  if (body.length === 0) {
    return { ok: false, reason: 'empty', message: 'Type your question first.' }
  }
  if (body.length > MAX_BODY) {
    return {
      ok: false,
      reason: 'empty',
      message: `That is longer than ${MAX_BODY} characters. Send the short version and we will call you.`,
    }
  }

  const [proposal] = await db
    .select({
      id: proposals.id,
      companyId: proposals.companyId,
      status: proposals.status,
      opportunityId: proposals.opportunityId,
    })
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  /*
    The same answer for a token that does not exist and a token that does: a
    different message for each would turn this into an oracle for guessing
    tokens, which is the one thing 32 random bytes is protecting.
  */
  if (!proposal) {
    return { ok: false, reason: 'not_found', message: 'That proposal is no longer available.' }
  }

  if (proposal.status === 'draft') {
    /*
      A draft has never been shown to anybody, so a question on one means the
      token leaked rather than that a client is asking something. Refused, and
      not recorded: writing it would put a stranger's text on a client's
      timeline.
    */
    return {
      ok: false,
      reason: 'not_sent',
      message: 'That proposal is no longer available.',
    }
  }

  const [recent] = await db
    .select({ count: sql<string>`count(*)` })
    .from(communications)
    .where(
      and(
        eq(communications.proposalId, proposal.id),
        eq(communications.direction, 'inbound'),
        gte(communications.occurredAt, new Date(Date.now() - 3_600_000)),
      ),
    )

  if (Number(recent?.count ?? 0) >= HOURLY_LIMIT) {
    return {
      ok: false,
      reason: 'rate_limited',
      message: 'That is a lot of questions in one hour. We have them — somebody will be in touch.',
    }
  }

  // The opportunity carries the organization and the contact to file this
  // against, so the client is not asked who they are.
  const [deal] = await db
    .select({
      organizationId: opportunities.organizationId,
      primaryContactId: opportunities.primaryContactId,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.id, proposal.opportunityId),
        eq(opportunities.companyId, proposal.companyId),
      ),
    )
    .limit(1)

  const [row] = await db
    .insert(communications)
    .values({
      companyId: proposal.companyId,
      organizationId: deal?.organizationId ?? null,
      contactId: deal?.primaryContactId ?? null,
      opportunityId: proposal.opportunityId,
      proposalId: proposal.id,
      channel: 'message',
      direction: 'inbound',
      summary: summaryOf(body),
      body,
      /*
        `actor_name` is where the client's typed name goes, and the column's own
        comment says why it fits: "Frozen, so an exchange keeps its author after
        they leave." A name from a public form is a *claim* rather than a proved
        identity — `contact_id` above carries who we believe we are talking to —
        and `actor_name` is already the field for "who did this, by name", which
        for an inbound exchange is whoever was at the other end.

        The fallback is "The client" rather than the contact's name: writing the
        contact's name would assert that this particular person typed it, which
        the token cannot establish.
      */
      actorName: input.askerName?.trim() || 'The client',
    })
    .returning()

  return { ok: true, id: row.id }
}

/**
 * Answers a question, as a reply on the same thread.
 *
 * Authenticated and permissioned, unlike asking: the client may ask through
 * their link and only the business may answer through the application.
 */
export async function answerQuestion(
  ctx: ActorContext,
  questionId: string,
  body: string,
  exec: Executor = db,
) {
  requirePermission(ctx, 'crm:manage')

  const trimmed = body.trim()
  if (trimmed.length === 0) throw new Refusal('Write the answer first.')
  if (trimmed.length > MAX_BODY) {
    throw new Refusal(`An answer longer than ${MAX_BODY} characters belongs in a call.`)
  }

  const [question] = await exec
    .select({
      id: communications.id,
      organizationId: communications.organizationId,
      contactId: communications.contactId,
      opportunityId: communications.opportunityId,
      proposalId: communications.proposalId,
      direction: communications.direction,
      parentId: communications.parentId,
    })
    .from(communications)
    .where(scoped(ctx, communications, eq(communications.id, questionId)))
    .limit(1)

  if (!question) throw new QuestionError('That question was not found.')

  if (question.direction !== 'inbound') {
    /*
      Only an inbound message is a question. Answering an answer would build a
      thread deeper than the two levels §7 asks for, and `parent_id` is a reply
      pointer rather than a tree — so the third message would claim to be a
      reply to a reply and the reader would have no way to order them.
    */
    throw new Refusal('That is not a question from the client, so there is nothing to answer.')
  }

  return exec.transaction(async (tx) => {
    const [answer] = await tx
      .insert(communications)
      .values({
        companyId: ctx.companyId,
        organizationId: question.organizationId,
        contactId: question.contactId,
        opportunityId: question.opportunityId,
        proposalId: question.proposalId,
        parentId: question.id,
        channel: 'message',
        direction: 'outbound',
        summary: summaryOf(trimmed),
        body: trimmed,
        recordedBy: ctx.userId,
        actorName: ctx.userName,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'proposal.question_answered',
        entityType: 'communication',
        entityId: answer.id,
        after: { questionId: question.id, proposalId: question.proposalId },
      },
      tx,
    )

    return answer
  })
}

export type ThreadEntry = {
  id: string
  direction: 'inbound' | 'outbound' | 'internal'
  summary: string
  body: string | null
  occurredAt: Date
  parentId: string | null
  /** Whether this question has an answer. */
  answered: boolean
}

/** Every question and answer on one proposal, oldest first. */
export async function threadForProposal(
  ctx: ActorContext,
  proposalId: string,
): Promise<ThreadEntry[]> {
  requirePermission(ctx, 'proposals:view')

  const rows = await db
    .select({
      id: communications.id,
      direction: communications.direction,
      summary: communications.summary,
      body: communications.body,
      occurredAt: communications.occurredAt,
      parentId: communications.parentId,
    })
    .from(communications)
    .where(scoped(ctx, communications, eq(communications.proposalId, proposalId)))
    .orderBy(asc(communications.occurredAt))

  const answeredIds = new Set(
    rows.map((row) => row.parentId).filter((id): id is string => id !== null),
  )

  return rows.map((row) => ({
    ...row,
    direction: row.direction as ThreadEntry['direction'],
    answered: answeredIds.has(row.id),
  }))
}

/**
 * The thread as the client sees it, read by token rather than by actor.
 *
 * Internal notes are excluded, which is the whole reason this is not
 * `threadForProposal` with a different caller: `communications` holds internal
 * notes about a client on the same timeline as exchanges with them, and the one
 * place that distinction must hold absolutely is the page the client is looking
 * at.
 */
export async function clientThread(publicToken: string): Promise<ThreadEntry[]> {
  const [proposal] = await db
    .select({ id: proposals.id, companyId: proposals.companyId })
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!proposal) return []

  const rows = await db
    .select({
      id: communications.id,
      direction: communications.direction,
      summary: communications.summary,
      body: communications.body,
      occurredAt: communications.occurredAt,
      parentId: communications.parentId,
    })
    .from(communications)
    .where(
      and(
        eq(communications.companyId, proposal.companyId),
        eq(communications.proposalId, proposal.id),
        // Belt and braces: the direction filter is the guarantee, and the
        // channel filter means a logged phone call about this proposal does not
        // appear on the client's screen either.
        eq(communications.channel, 'message'),
        sql`${communications.direction} <> 'internal'`,
      ),
    )
    .orderBy(asc(communications.occurredAt))

  const answeredIds = new Set(
    rows.map((row) => row.parentId).filter((id): id is string => id !== null),
  )

  return rows.map((row) => ({
    ...row,
    direction: row.direction as ThreadEntry['direction'],
    answered: answeredIds.has(row.id),
  }))
}

/**
 * Questions nobody has answered, across every proposal.
 *
 * The list a salesperson opens. Ordered oldest first, because the one that has
 * been waiting longest is the one costing the deal.
 */
export async function unansweredQuestions(ctx: ActorContext, limit = 50) {
  requirePermission(ctx, 'proposals:view')

  const answers = db
    .select({ parentId: communications.parentId })
    .from(communications)
    .where(
      and(eq(communications.companyId, ctx.companyId), sql`${communications.parentId} is not null`),
    )
    .as('answers')

  return db
    .select({
      id: communications.id,
      proposalId: communications.proposalId,
      organizationId: communications.organizationId,
      summary: communications.summary,
      body: communications.body,
      occurredAt: communications.occurredAt,
      proposalNumber: proposals.number,
      contactName: contacts.firstName,
    })
    .from(communications)
    .leftJoin(
      proposals,
      and(
        eq(proposals.id, communications.proposalId),
        eq(proposals.companyId, communications.companyId),
      ),
    )
    .leftJoin(
      contacts,
      and(
        eq(contacts.id, communications.contactId),
        eq(contacts.companyId, communications.companyId),
      ),
    )
    .leftJoin(answers, eq(answers.parentId, communications.id))
    .where(
      scoped(
        ctx,
        communications,
        eq(communications.direction, 'inbound'),
        eq(communications.channel, 'message'),
        sql`${communications.proposalId} is not null`,
        isNull(answers.parentId),
      ),
    )
    .orderBy(asc(communications.occurredAt))
    .limit(limit)
}
