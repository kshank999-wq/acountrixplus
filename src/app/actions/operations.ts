'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { requirePermission } from '@/modules/tenancy/context'
import { cancelJob, enqueue, retryJob } from '@/modules/worker/queue'
import { setScheduleActive } from '@/modules/worker/schedules'
import { getHandler } from '@/modules/worker/registry'
import { runOnce } from '@/modules/worker/runner'
import { postDraftEntry, discardDraftEntry } from '@/modules/ledger/journal'
import '@/modules/worker/handlers'
import { messageFor } from '@/modules/errors'

/**
 * Server actions for the operations page.
 *
 * Every one of these checks `operations:manage` rather than relying on the
 * page having hidden the button. A page that hides a control is a courtesy;
 * the check is the security boundary.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    revalidatePath('/settings/operations')
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

const uuid = z.string().uuid()

export async function retryJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    requirePermission(actor, 'operations:manage')

    await retryJob(uuid.parse(jobId))
    return 'Queued again, with its attempts reset.'
  })
}

export async function cancelJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    requirePermission(actor, 'operations:manage')

    await cancelJob(uuid.parse(jobId))
    return 'Cancelled.'
  })
}

export async function setScheduleActiveAction(
  scheduleId: string,
  isActive: boolean,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    requirePermission(actor, 'operations:manage')

    await setScheduleActive(uuid.parse(scheduleId), isActive)
    return isActive ? 'Schedule resumed.' : 'Schedule paused. It will not fire until resumed.'
  })
}

/**
 * Queues a job now, from the page.
 *
 * Deliberately enqueues rather than running inline: a handler that takes a
 * minute would hold a browser request open, and more to the point, running it
 * outside the queue would be a second execution path that the queue's
 * retry, dedupe, and visibility never touch.
 */
export async function runNowAction(kind: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    requirePermission(actor, 'operations:manage')

    const definition = getHandler(kind)
    if (!definition) throw new Error(`No handler registered for "${kind}".`)

    const result = await enqueue({
      kind,
      companyId: definition.global ? null : actor.companyId,
      // Ahead of the routine queue, because somebody is watching this one.
      priority: 5,
      dedupeKey: `manual:${kind}:${actor.companyId}:${Date.now()}`,
    })

    return result.enqueued
      ? `Queued. It will run on the next worker tick.`
      : 'Already queued.'
  })
}

/**
 * Drains the queue once, from the browser.
 *
 * For development and for a deployment that has not started a worker yet. It
 * calls the same `runOnce` the worker loop calls, so there is no second
 * behaviour to keep in step — and the page says plainly that this is not how
 * it should work in production.
 */
export async function tickWorkerAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    requirePermission(actor, 'operations:manage')

    const tick = await runOnce({ workerId: `browser-${actor.userId.slice(0, 8)}` })

    return (
      `${tick.jobsRun} ${tick.jobsRun === 1 ? 'job' : 'jobs'} run — ` +
      `${tick.jobsSucceeded} succeeded, ${tick.jobsFailed} retrying, ${tick.jobsDead} dead. ` +
      `${tick.schedulesFired} scheduled, ${tick.eventsRelayed} events relayed.`
    )
  })
}

// --- Proposed entries ------------------------------------------------------

export async function postDraftEntryAction(entryId: string): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const entry = await postDraftEntry(actor, uuid.parse(entryId))

    revalidatePath('/settings/operations')
    revalidatePath('/accounting')
    revalidatePath('/accounting/journal')

    return { ok: true, message: `Entry ${entry.entryNumber} posted.` }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Could not post it.') }
  }
}

export async function discardDraftEntryAction(entryId: string): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await discardDraftEntry(actor, uuid.parse(entryId))

    revalidatePath('/settings/operations')
    revalidatePath('/accounting/journal')

    return { ok: true, message: 'Proposal discarded. Nothing reached the books.' }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Could not discard it.') }
  }
}
