import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { communications, contacts, opportunities, organizations } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'

/**
 * The communications log (spec §16 `Communication`, §6).
 *
 * What a person said to somebody outside the company, kept where the next
 * person to pick up the phone will find it.
 *
 * Deliberately *not* the activity feed. `opportunity_activities` is generated
 * by the software and answers "what happened"; this is written by hand and
 * answers "what was said". Merging them would mean the useful half — three
 * sentences somebody typed after a difficult call — scrolling out of sight
 * behind forty automatic stage changes.
 */

export type CommunicationChannel = 'email' | 'call' | 'meeting' | 'note' | 'letter' | 'message'
export type CommunicationDirection = 'outbound' | 'inbound' | 'internal'

export class CommunicationError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'CommunicationError'
  }
}

export type LogInput = {
  organizationId?: string | null
  contactId?: string | null
  opportunityId?: string | null
  channel: CommunicationChannel
  direction: CommunicationDirection
  summary: string
  body?: string | null
  /** When it happened, not when it was typed. Defaults to now. */
  occurredAt?: Date
  transactionalMessageId?: string | null
}

/**
 * Records an exchange.
 *
 * Every party named is proved to belong to the caller's company first — three
 * lookups rather than trusting three uuids from a form. And the organization is
 * *derived* when it can be: somebody logging a call against a contact should
 * not have to also name the company that contact works for, and if they had to,
 * half the log would be missing it and the client timeline would be full of
 * holes.
 */
export async function logCommunication(
  ctx: ActorContext,
  input: LogInput,
  exec?: Executor,
): Promise<{ id: string }> {
  requirePermission(ctx, 'crm:manage')

  const summary = input.summary.trim()
  if (!summary) throw new CommunicationError('Say what the exchange was, in one line.')
  if (summary.length > 300) {
    throw new CommunicationError('That summary is longer than 300 characters — put it in the body.')
  }

  const write = async (tx: Executor) => {
    let organizationId = input.organizationId ?? null
    const contactId = input.contactId ?? null
    const opportunityId = input.opportunityId ?? null

    if (contactId) {
      const [contact] = await tx
        .select({ organizationId: contacts.organizationId })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.companyId, ctx.companyId)))
        .limit(1)

      if (!contact) throw new CommunicationError('That contact does not exist.')
      organizationId = organizationId ?? contact.organizationId
    }

    if (opportunityId) {
      const [opportunity] = await tx
        .select({ organizationId: opportunities.organizationId })
        .from(opportunities)
        .where(
          and(eq(opportunities.id, opportunityId), eq(opportunities.companyId, ctx.companyId)),
        )
        .limit(1)

      if (!opportunity) throw new CommunicationError('That opportunity does not exist.')
      organizationId = organizationId ?? opportunity.organizationId
    }

    if (organizationId) {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(eq(organizations.id, organizationId), eq(organizations.companyId, ctx.companyId)),
        )
        .limit(1)

      if (!organization) throw new CommunicationError('That client does not exist.')
    }

    if (!organizationId && !contactId && !opportunityId) {
      throw new CommunicationError('An exchange has to be with somebody.')
    }

    const [row] = await tx
      .insert(communications)
      .values({
        companyId: ctx.companyId,
        organizationId,
        contactId,
        opportunityId,
        channel: input.channel,
        direction: input.direction,
        summary,
        body: input.body?.trim() || null,
        occurredAt: input.occurredAt ?? new Date(),
        transactionalMessageId: input.transactionalMessageId ?? null,
        recordedBy: ctx.userId,
        // Carries the practice name when an accountant logs it, the same way
        // the audit log and accountant notes do.
        actorName: ctx.viaPractice ? `${ctx.userName} (${ctx.viaPractice})` : ctx.userName,
      })
      .returning({ id: communications.id })

    return row
  }

  // No audit event. A communication *is* the record — auditing it would file a
  // second row saying "somebody wrote a row", which is noise. The audit log
  // covers privileged actions, and writing down a phone call is not one.
  return exec ? write(exec) : db.transaction(write)
}

export type CommunicationRow = {
  id: string
  channel: CommunicationChannel
  direction: CommunicationDirection
  summary: string
  body: string | null
  occurredAt: Date
  actorName: string
  contactName: string | null
  wasSentByTheSystem: boolean
}

function contactName() {
  return sql<string | null>`nullif(btrim(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})), '')`
}

/**
 * Everything said to one client, newest first.
 *
 * Includes exchanges logged against a contact or an opportunity belonging to
 * that client, not only ones filed directly against it. Somebody who logged a
 * call against the person they spoke to expects it to appear on the company's
 * timeline, and a query that only matched the direct column would quietly show
 * them an empty page.
 */
export async function communicationsForOrganization(
  ctx: ActorContext,
  organizationId: string,
  limit = 100,
): Promise<CommunicationRow[]> {
  requirePermission(ctx, 'crm:view')

  const [contactIds, opportunityIds] = await Promise.all([
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(scoped(ctx, contacts, eq(contacts.organizationId, organizationId))),
    db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(scoped(ctx, opportunities, eq(opportunities.organizationId, organizationId))),
  ])

  const matches = [
    eq(communications.organizationId, organizationId),
    ...(contactIds.length
      ? [inArray(communications.contactId, contactIds.map((row) => row.id))]
      : []),
    ...(opportunityIds.length
      ? [inArray(communications.opportunityId, opportunityIds.map((row) => row.id))]
      : []),
  ]

  return db
    .select({
      id: communications.id,
      channel: communications.channel,
      direction: communications.direction,
      summary: communications.summary,
      body: communications.body,
      occurredAt: communications.occurredAt,
      actorName: communications.actorName,
      contactName: contactName(),
      wasSentByTheSystem: sql<boolean>`${communications.transactionalMessageId} is not null`,
    })
    .from(communications)
    .leftJoin(contacts, eq(contacts.id, communications.contactId))
    .where(scoped(ctx, communications, or(...matches)))
    .orderBy(desc(communications.occurredAt))
    .limit(limit)
}

/** Everything said about one deal, newest first. */
export async function communicationsForOpportunity(
  ctx: ActorContext,
  opportunityId: string,
  limit = 100,
): Promise<CommunicationRow[]> {
  requirePermission(ctx, 'crm:view')

  return db
    .select({
      id: communications.id,
      channel: communications.channel,
      direction: communications.direction,
      summary: communications.summary,
      body: communications.body,
      occurredAt: communications.occurredAt,
      actorName: communications.actorName,
      contactName: contactName(),
      wasSentByTheSystem: sql<boolean>`${communications.transactionalMessageId} is not null`,
    })
    .from(communications)
    .leftJoin(contacts, eq(contacts.id, communications.contactId))
    .where(scoped(ctx, communications, eq(communications.opportunityId, opportunityId)))
    .orderBy(desc(communications.occurredAt))
    .limit(limit)
}

/**
 * When each client was last spoken to.
 *
 * The question a sales list is opened to answer, and one query rather than one
 * per row. Clients with no exchange at all are absent, which is what the
 * caller wants: "never" and "not recently" are different problems.
 */
export async function lastContactedAt(
  ctx: ActorContext,
  organizationIds: string[],
): Promise<Map<string, Date>> {
  if (organizationIds.length === 0) return new Map()
  requirePermission(ctx, 'crm:view')

  const rows = await db
    .select({
      organizationId: communications.organizationId,
      // Typed as a string, because that is what the driver returns for a raw
      // aggregate — `sql<Date>` here would be an assertion the driver does not
      // honour, and every caller doing `.toISOString()` would throw.
      at: sql<string>`max(${communications.occurredAt})`,
    })
    .from(communications)
    .where(
      scoped(
        ctx,
        communications,
        inArray(communications.organizationId, organizationIds),
        // An internal note to self is not contact. Counting it would let a
        // team convince itself it had spoken to somebody it had not.
        sql`${communications.direction} <> 'internal'`,
      ),
    )
    .groupBy(communications.organizationId)

  return new Map(
    rows
      .filter((row) => row.organizationId)
      .map((row) => [row.organizationId as string, new Date(row.at)]),
  )
}
