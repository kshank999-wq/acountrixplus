import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { contacts, memberships, opportunities, organizations, tasks, users } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'

/**
 * Follow-up work (spec §16 `Task`, §10 "engagement can create tasks").
 *
 * The table has existed since Phase 5, written only by marketing engagement and
 * read only by the marketing overview — half of §16's entity, reachable from
 * one screen nobody in sales opens. This is the other half.
 *
 * ## What it is not
 *
 * Not a project-management surface. No subtasks, no dependencies, no boards, no
 * estimates. A task here is a promise somebody made to do one thing by one
 * date, and the only questions it has to answer are "what is on my desk today"
 * and "what did we forget".
 */

export type TaskPriority = 'low' | 'normal' | 'high'
export type TaskStatus = 'open' | 'done' | 'cancelled'

export class TaskError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'TaskError'
  }
}

export type CreateTaskInput = {
  title: string
  detail?: string | null
  dueOn?: string | null
  priority?: TaskPriority
  assignedTo?: string | null
  organizationId?: string | null
  contactId?: string | null
  opportunityId?: string | null
  campaignId?: string | null
}

/**
 * Raises a follow-up.
 *
 * Unassigned is allowed and is not the same as unimportant: "somebody should
 * call them back" is a real state, and forcing an assignee at creation is how
 * a note-to-the-team becomes a note to whoever happened to be typing.
 */
export async function createTask(
  ctx: ActorContext,
  input: CreateTaskInput,
  exec?: Executor,
): Promise<{ id: string }> {
  requirePermission(ctx, 'crm:manage')

  const title = input.title.trim()
  if (!title) throw new TaskError('A task needs a title.')

  const write = async (tx: Executor) => {
    // Each named party proved to be this company's, rather than trusted from
    // a form. A task pointing at another tenant's opportunity would appear on
    // nobody's list and hold a foreign key nobody expected.
    let organizationId = input.organizationId ?? null

    if (organizationId) {
      await requireOwn(tx, ctx, organizations, organizationId, 'client')
    }

    // The client is derived from the person or the deal, the same way
    // `logCommunication` derives it — and for the same reason. A follow-up
    // raised on an opportunity is a promise made to that opportunity's client,
    // and a row that does not say so appears on no client's timeline and shows
    // no name on the board.
    if (input.contactId) {
      const client = await requireOwnParty(tx, ctx, contacts, input.contactId, 'contact')
      organizationId = organizationId ?? client
    }
    if (input.opportunityId) {
      const client = await requireOwnParty(
        tx,
        ctx,
        opportunities,
        input.opportunityId,
        'opportunity',
      )
      organizationId = organizationId ?? client
    }

    if (input.assignedTo) await requireMember(tx, ctx, input.assignedTo)

    const [row] = await tx
      .insert(tasks)
      .values({
        companyId: ctx.companyId,
        title,
        detail: input.detail?.trim() || null,
        dueOn: input.dueOn ?? null,
        priority: input.priority ?? 'normal',
        assignedTo: input.assignedTo ?? null,
        organizationId,
        contactId: input.contactId ?? null,
        opportunityId: input.opportunityId ?? null,
        campaignId: input.campaignId ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: tasks.id })

    return row
  }

  return exec ? write(exec) : db.transaction(write)
}

/**
 * Marks a task finished.
 *
 * The precondition lives in the write — `WHERE status = 'open'` — so two people
 * closing the same follow-up at once produce one completion and one honest
 * refusal, rather than a second `completedAt` overwriting the first and the
 * "done this week" count quietly gaining a row.
 */
export async function completeTask(
  ctx: ActorContext,
  taskId: string,
  outcome?: string,
): Promise<boolean> {
  requirePermission(ctx, 'crm:manage')

  const done = await db
    .update(tasks)
    .set({
      status: 'done',
      completedAt: new Date(),
      completedBy: ctx.userId,
      outcome: outcome?.trim() || null,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.companyId, ctx.companyId),
        eq(tasks.status, 'open'),
      ),
    )
    .returning({ id: tasks.id })

  return done.length > 0
}

/** Drops a task that should not have been raised, with a reason. */
export async function cancelTask(
  ctx: ActorContext,
  taskId: string,
  outcome?: string,
): Promise<boolean> {
  requirePermission(ctx, 'crm:manage')

  const done = await db
    .update(tasks)
    .set({
      status: 'cancelled',
      // The CHECK constraint requires a finished task to carry a finish time,
      // and a cancelled task is finished. Leaving it null would make every
      // open-work query disagree with every completion count.
      completedAt: new Date(),
      completedBy: ctx.userId,
      outcome: outcome?.trim() || null,
    })
    .where(
      and(eq(tasks.id, taskId), eq(tasks.companyId, ctx.companyId), eq(tasks.status, 'open')),
    )
    .returning({ id: tasks.id })

  return done.length > 0
}

/** Puts a closed task back on the list, when it turns out it was not done. */
export async function reopenTask(ctx: ActorContext, taskId: string): Promise<boolean> {
  requirePermission(ctx, 'crm:manage')

  const done = await db
    .update(tasks)
    .set({ status: 'open', completedAt: null, completedBy: null })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.companyId, ctx.companyId),
        inArray(tasks.status, ['done', 'cancelled']),
      ),
    )
    .returning({ id: tasks.id })

  return done.length > 0
}

/** Hands a task to somebody, or takes the owner off it. */
export async function assignTask(
  ctx: ActorContext,
  taskId: string,
  userId: string | null,
): Promise<boolean> {
  requirePermission(ctx, 'crm:manage')

  if (userId) await requireMember(db, ctx, userId)

  const done = await db
    .update(tasks)
    .set({ assignedTo: userId })
    .where(and(eq(tasks.id, taskId), eq(tasks.companyId, ctx.companyId)))
    .returning({ id: tasks.id })

  return done.length > 0
}

export type TaskRow = {
  id: string
  title: string
  detail: string | null
  dueOn: string | null
  priority: TaskPriority
  status: TaskStatus
  assignedTo: string | null
  assigneeName: string | null
  organizationId: string | null
  organizationName: string | null
  opportunityId: string | null
  outcome: string | null
  completedAt: Date | null
}

function selection() {
  return {
    id: tasks.id,
    title: tasks.title,
    detail: tasks.detail,
    dueOn: tasks.dueOn,
    priority: tasks.priority,
    status: tasks.status,
    assignedTo: tasks.assignedTo,
    assigneeName: users.name,
    organizationId: tasks.organizationId,
    organizationName: organizations.name,
    opportunityId: tasks.opportunityId,
    outcome: tasks.outcome,
    completedAt: tasks.completedAt,
  }
}

function withNames() {
  return db
    .select(selection())
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedTo))
    .leftJoin(organizations, eq(organizations.id, tasks.organizationId))
}

/**
 * What is on one person's desk.
 *
 * Unassigned work is included by default, because a task nobody owns is
 * everybody's problem and hiding it until somebody claims it is how it stops
 * being anybody's. Ordered by date with undated work last: something due
 * Tuesday outranks something due "eventually".
 */
export async function myWork(
  ctx: ActorContext,
  options: { includeUnassigned?: boolean; limit?: number } = {},
): Promise<TaskRow[]> {
  requirePermission(ctx, 'crm:view')

  const mine = eq(tasks.assignedTo, ctx.userId)
  const ownership =
    options.includeUnassigned === false ? mine : or(mine, isNull(tasks.assignedTo))

  return withNames()
    .where(scoped(ctx, tasks, eq(tasks.status, 'open'), ownership))
    .orderBy(sql`${tasks.dueOn} asc nulls last`, asc(tasks.createdAt))
    .limit(options.limit ?? 100)
}

/**
 * Everything open in the company, for a manager's view.
 *
 * `asOf` is a parameter rather than a clock read, so a report can be run for a
 * date and a test can assert on one — the same rule Phase 21 applied to the
 * PDF's timestamp, for the same reason.
 */
export async function openWork(
  ctx: ActorContext,
  options: { asOf?: string; overdueOnly?: boolean; limit?: number } = {},
): Promise<TaskRow[]> {
  requirePermission(ctx, 'crm:view')

  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10)

  return withNames()
    .where(
      scoped(
        ctx,
        tasks,
        eq(tasks.status, 'open'),
        ...(options.overdueOnly ? [lte(tasks.dueOn, asOf)] : []),
      ),
    )
    .orderBy(sql`${tasks.dueOn} asc nulls last`, asc(tasks.createdAt))
    .limit(options.limit ?? 200)
}

/** Follow-ups attached to one client, open first, then recently closed. */
export async function tasksForOrganization(
  ctx: ActorContext,
  organizationId: string,
): Promise<TaskRow[]> {
  requirePermission(ctx, 'crm:view')

  return withNames()
    .where(scoped(ctx, tasks, eq(tasks.organizationId, organizationId)))
    .orderBy(sql`case when ${tasks.status} = 'open' then 0 else 1 end`, sql`${tasks.dueOn} asc nulls last`)
    .limit(50)
}

/**
 * What has been closed lately, newest first.
 *
 * Exists so that closing is reversible from the screen that closes things. A
 * Done button with no list of what it has done makes one mis-click permanent,
 * and it leaves `reopenTask` reachable only from a test — which is another way
 * of saying it is not built.
 *
 * `since` is a parameter for the same reason `asOf` is: a count somebody reads
 * beside a list has to be counted over the same window as the list.
 */
export async function closedWork(
  ctx: ActorContext,
  options: { since?: string; limit?: number } = {},
): Promise<TaskRow[]> {
  requirePermission(ctx, 'crm:view')

  const since = options.since
    ? new Date(`${options.since}T00:00:00Z`)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  return withNames()
    .where(
      scoped(
        ctx,
        tasks,
        inArray(tasks.status, ['done', 'cancelled']),
        gte(tasks.completedAt, since),
      ),
    )
    .orderBy(desc(tasks.completedAt))
    .limit(options.limit ?? 25)
}

export type WorkSummary = {
  open: number
  overdue: number
  dueToday: number
  unassigned: number
  /** Closed since `since` — done and dropped together, because both are finished. */
  closed: number
}

/** The counts a header needs, in one query rather than five. */
export async function workSummary(
  ctx: ActorContext,
  asOf?: string,
  since?: string,
): Promise<WorkSummary> {
  requirePermission(ctx, 'crm:view')

  const today = asOf ?? new Date().toISOString().slice(0, 10)
  const closedSince = since
    ? new Date(`${since}T00:00:00Z`)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // The four open counts and the closed one come from one scan, so the rows are
  // not filtered in the WHERE — every count carries its own `filter` clause and
  // the open ones say `status = 'open'` explicitly. A shared WHERE would have to
  // be the union of both windows, which is the same scan and a less obvious one.
  const open = sql`${tasks.status} = 'open'`
  // Built with `gte` rather than interpolated, because a bare `Date` dropped
  // into a template is a parameter with no encoder attached and the driver
  // refuses to bind it. The column knows how to serialise its own type.
  const finishedInWindow = gte(tasks.completedAt, closedSince)

  const [row] = await db
    .select({
      open: sql<string>`count(*) filter (where ${open})`,
      overdue: sql<string>`count(*) filter (where ${open} and ${tasks.dueOn} < ${today})`,
      dueToday: sql<string>`count(*) filter (where ${open} and ${tasks.dueOn} = ${today})`,
      unassigned: sql<string>`count(*) filter (where ${open} and ${tasks.assignedTo} is null)`,
      closed: sql<string>`count(*) filter (where ${finishedInWindow})`,
    })
    .from(tasks)
    .where(scoped(ctx, tasks, or(eq(tasks.status, 'open'), finishedInWindow)))

  return {
    open: Number(row?.open ?? 0),
    overdue: Number(row?.overdue ?? 0),
    dueToday: Number(row?.dueToday ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
    closed: Number(row?.closed ?? 0),
  }
}

// --- Guards ------------------------------------------------------------------

type OwnedTable = typeof organizations | typeof contacts | typeof opportunities

/** Proves a record belongs to the caller's company. */
async function requireOwn(
  exec: Executor,
  ctx: ActorContext,
  table: OwnedTable,
  id: string,
  label: string,
): Promise<void> {
  const [row] = await exec
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)))
    .limit(1)

  if (!row) throw new TaskError(`That ${label} does not exist.`)
}

/**
 * The same proof, plus the client the party belongs to, so a task can inherit
 * it. Only the two tables that *have* a client — an organization is its own.
 */
async function requireOwnParty(
  exec: Executor,
  ctx: ActorContext,
  table: typeof contacts | typeof opportunities,
  id: string,
  label: string,
): Promise<string | null> {
  const [row] = await exec
    .select({ organizationId: table.organizationId })
    .from(table)
    .where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)))
    .limit(1)

  if (!row) throw new TaskError(`That ${label} does not exist.`)
  return row.organizationId
}

/**
 * A task can only be given to somebody who works here.
 *
 * Checked against `memberships` rather than `users`, so a person who exists in
 * another company cannot be handed work in this one by id.
 */
async function requireMember(exec: Executor, ctx: ActorContext, userId: string): Promise<void> {
  const [row] = await exec
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.companyId, ctx.companyId)))
    .limit(1)

  if (!row) throw new TaskError('That person does not work here.')
}
