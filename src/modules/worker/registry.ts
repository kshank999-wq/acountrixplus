import type { ActorContext } from '@/modules/tenancy/context'

/**
 * The handler registry.
 *
 * ## Why a handler gets a context rather than making one
 *
 * Every service in this codebase takes an `ActorContext` first, and that is
 * what makes tenant scoping structural instead of a thing each call site
 * remembers (ADR 0001). A background job has no signed-in user, which is
 * exactly the situation where it would be tempting to reach past `scoped()`
 * and query by hand.
 *
 * So the runner *builds* a context for the job's company and hands it over.
 * The handler is written like any other caller, `scoped()` still applies, and
 * a job cannot see across tenants by forgetting to filter.
 */

/** The acting identity for work nobody requested. */
export const SYSTEM_ACTOR_NAME = 'Scheduled task'

export type JobContext = {
  /**
   * Scoped to the job's company, with the `owner` role.
   *
   * Owner is right and worth defending: a scheduled task acts *for the
   * company*, not on behalf of any member, and giving it a lesser role would
   * mean a nightly job silently doing less than the nightly job it replaced.
   * The narrowing that matters is which handlers exist at all, and that is
   * decided here in code rather than at runtime by a role.
   *
   * Null for housekeeping that spans every tenant.
   */
  actor: ActorContext | null
  companyId: string | null
  payload: Record<string, unknown>
  /** Which attempt this is, starting at 1. Handlers log it; few branch on it. */
  attempt: number
  jobId: string
}

/** What a handler returns is stored on the job and shown on the operations page. */
export type JobResult = Record<string, unknown> | void

export type JobHandler = (context: JobContext) => Promise<JobResult>

export type HandlerDefinition = {
  kind: string
  /** Shown on the operations page, so somebody can tell what a row is. */
  label: string
  /**
   * True when the handler runs across every company and gets no actor.
   * Checked by the runner, so a tenant job cannot quietly become a global one.
   */
  global?: boolean
  handler: JobHandler
}

const handlers = new Map<string, HandlerDefinition>()

export function registerHandler(definition: HandlerDefinition): void {
  handlers.set(definition.kind, definition)
}

export function getHandler(kind: string): HandlerDefinition | undefined {
  return handlers.get(kind)
}

export function registeredKinds(): HandlerDefinition[] {
  return [...handlers.values()].sort((a, b) => a.kind.localeCompare(b.kind))
}

/**
 * Raised when a job names a handler nothing registered.
 *
 * Its own class because it is the one failure that retrying cannot fix: a
 * deploy that removed a handler while jobs of that kind were queued will fail
 * them identically five times and then dead-letter them. The runner uses this
 * to skip straight to dead, so the queue does not spend an hour rediscovering
 * that the code is missing.
 */
export class UnknownJobKindError extends Error {
  constructor(readonly kind: string) {
    super(
      `No handler registered for "${kind}". Registered: ${[...handlers.keys()].sort().join(', ') || '(none)'}`,
    )
    this.name = 'UnknownJobKindError'
  }
}
