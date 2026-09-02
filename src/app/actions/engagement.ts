'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { logCommunication } from '@/modules/engagement/communications'
import { organizationTimeline } from '@/modules/engagement/timeline'
import { partsOf, type Part } from '@/modules/engagement/entry'
import {
  assignTask,
  cancelTask,
  completeTask,
  createTask,
  reopenTask,
} from '@/modules/engagement/tasks'
import { messageFor } from '@/modules/errors'

/** Server actions for communications and tasks (spec §6, §16, Phase 22). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const uuid = z.string().uuid()

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/crm', '/crm/work', '/crm/organizations', '/marketing']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

export type TimelineView = {
  kind: 'communication' | 'task' | 'activity'
  at: string
  title: string
  detail: string | null
  /**
   * The labelled parts of a communication entry (Phase 92).
   *
   * A note somebody typed and a letter this company sent are different kinds of
   * evidence, and a screen must not render them as one unlabelled block — see
   * `engagement/entry`. Empty for tasks and activities, which have neither.
   */
  parts: Part[]
  who: string | null
  tone: 'inbound' | 'outbound' | 'internal' | 'system' | 'open' | 'closed'
}

/**
 * The client timeline, fetched when somebody opens one.
 *
 * Loaded on demand rather than with the list: a page of forty clients would
 * otherwise run forty timelines to render forty collapsed rows.
 */
export async function organizationTimelineAction(
  organizationId: unknown,
): Promise<TimelineView[]> {
  const actor = await requireActor()
  const entries = await organizationTimeline(actor, uuid.parse(organizationId))

  return entries.map((entry) => {
    if (entry.kind === 'communication') {
      return {
        kind: 'communication' as const,
        at: entry.at.toISOString().slice(0, 10),
        title: entry.data.summary,
        // Kept for callers that want one line; `parts` is what the timeline
        // renders, because a note and a letter must stay told apart.
        detail: entry.data.body,
        parts: partsOf({
          note: entry.data.body,
          letter: entry.data.letter,
          sentByTheSystem: entry.data.wasSentByTheSystem,
        }),
        who: entry.data.contactName ?? entry.data.actorName,
        tone: entry.data.wasSentByTheSystem ? ('system' as const) : entry.data.direction,
      }
    }

    if (entry.kind === 'task') {
      return {
        kind: 'task' as const,
        at: entry.at.toISOString().slice(0, 10),
        title: entry.data.title,
        detail: entry.data.outcome ?? entry.data.detail,
        parts: [],
        who: entry.data.assigneeName,
        tone: entry.data.completedAt ? ('closed' as const) : ('open' as const),
      }
    }

    return {
      kind: 'activity' as const,
      at: entry.at.toISOString().slice(0, 10),
      title: entry.data.summary,
      detail: null,
      parts: [],
      who: entry.data.actorName,
      tone: 'system' as const,
    }
  })
}

export async function logCommunicationAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        organizationId: uuid.optional().nullable(),
        contactId: uuid.optional().nullable(),
        opportunityId: uuid.optional().nullable(),
        channel: z.enum(['email', 'call', 'meeting', 'note', 'letter', 'message']),
        direction: z.enum(['outbound', 'inbound', 'internal']),
        summary: z.string().trim().min(1, 'Say what the exchange was, in one line.'),
        body: z.string().trim().optional(),
        // A date rather than a timestamp: somebody logging Friday's call on
        // Monday knows the day and not the minute, and asking for the minute
        // gets a made-up one.
        occurredOn: z.string().optional(),
      })
      .parse(input)

    await logCommunication(actor, {
      organizationId: parsed.organizationId ?? null,
      contactId: parsed.contactId ?? null,
      opportunityId: parsed.opportunityId ?? null,
      channel: parsed.channel,
      direction: parsed.direction,
      summary: parsed.summary,
      body: parsed.body,
      occurredAt: parsed.occurredOn ? new Date(`${parsed.occurredOn}T12:00:00Z`) : undefined,
    })

    return 'Logged.'
  })
}

export async function createTaskAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        title: z.string().trim().min(1, 'A task needs a title.'),
        detail: z.string().trim().optional(),
        dueOn: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        assignedTo: uuid.optional().nullable(),
        organizationId: uuid.optional().nullable(),
        opportunityId: uuid.optional().nullable(),
      })
      .parse(input)

    await createTask(actor, {
      title: parsed.title,
      detail: parsed.detail,
      dueOn: parsed.dueOn || null,
      priority: parsed.priority,
      assignedTo: parsed.assignedTo ?? null,
      organizationId: parsed.organizationId ?? null,
      opportunityId: parsed.opportunityId ?? null,
    })

    return parsed.dueOn ? `Raised, due ${parsed.dueOn}.` : 'Raised.'
  })
}

export async function completeTaskAction(
  taskId: unknown,
  outcome?: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const done = await completeTask(
      actor,
      uuid.parse(taskId),
      typeof outcome === 'string' ? outcome : undefined,
    )

    if (!done) throw new Error('That was already closed by somebody else.')
    return 'Done.'
  })
}

export async function cancelTaskAction(taskId: unknown, outcome?: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const done = await cancelTask(
      actor,
      uuid.parse(taskId),
      typeof outcome === 'string' ? outcome : undefined,
    )

    if (!done) throw new Error('That was already closed.')
    return 'Dropped.'
  })
}

export async function reopenTaskAction(taskId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const done = await reopenTask(actor, uuid.parse(taskId))

    if (!done) throw new Error('That is already open.')
    return 'Back on the list.'
  })
}

export async function assignTaskAction(taskId: unknown, userId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const done = await assignTask(
      actor,
      uuid.parse(taskId),
      userId ? uuid.parse(userId) : null,
    )

    if (!done) throw new Error('That task does not exist.')
    return userId ? 'Assigned.' : 'Unassigned — back on the shared list.'
  })
}
