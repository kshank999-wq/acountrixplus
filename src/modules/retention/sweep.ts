import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  actionTokens,
  campaignEvents,
  documentBlobs,
  domainEvents,
  leadSubmissions,
  loginAttempts,
  proposalViews,
  sessions,
  transactionalMessages,
} from '@/db/schema'
import { sweepOrphanedBlobs } from '@/modules/evidence/store'
import {
  RETENTION_POLICIES,
  cutoffFor,
  policyFor,
  type RetentionKind,
  type RetentionPolicy,
} from './policy'

/**
 * Doing what the policy says (spec §19).
 *
 * ## Counting is a separate query from deleting, on purpose
 *
 * Every policy has a `count` and a `remove`, and the operations page runs the
 * counts. Somebody is entitled to see what a retention policy would take
 * before it takes it — a number nobody can check before the delete is a number
 * nobody can dispute after it.
 *
 * ## Every sweep is safe to run at any time, twice
 *
 * They are ranged deletes on a cutoff, so a second run deletes nothing and a
 * half-finished run leaves the rest for the next one. No sweep needs the
 * previous one to have succeeded, which is what lets the schedule be dumb.
 */

export type SweepResult = {
  kind: RetentionKind
  label: string
  removed: number
}

export type RetentionCount = {
  kind: RetentionKind
  label: string
  days: number | null
  publicallyWritten: boolean
  why: string
  /** Rows the policy would remove if it ran now. */
  expired: number
  /** Rows it is holding, which is the half a privacy question asks about. */
  held: number
}

type Sweep = {
  count: (cutoff: Date | null, exec: Executor) => Promise<{ expired: number; held: number }>
  remove: (cutoff: Date | null, exec: Executor) => Promise<number>
}

async function tally(
  exec: Executor,
  from: { expired: Promise<Array<{ n: string }>>; held: Promise<Array<{ n: string }>> },
): Promise<{ expired: number; held: number }> {
  const [expired, held] = await Promise.all([from.expired, from.held])
  return { expired: Number(expired[0]?.n ?? 0), held: Number(held[0]?.n ?? 0) }
}

const N = sql<string>`count(*)`

const SWEEPS: Record<RetentionKind, Sweep> = {
  login_attempts: {
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(loginAttempts)
          .where(lt(loginAttempts.createdAt, cutoff!)),
        held: exec.select({ n: N }).from(loginAttempts),
      }),
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(loginAttempts)
        .where(lt(loginAttempts.createdAt, cutoff!))
        .returning({ id: loginAttempts.id })
      return removed.length
    },
  },

  action_tokens: {
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(actionTokens)
          .where(lt(actionTokens.expiresAt, cutoff!)),
        held: exec.select({ n: N }).from(actionTokens),
      }),
    // Delegates to Phase 19's own prune, which measures from the token's
    // expiry rather than its creation — a week-long invitation issued 29 days
    // ago has not been expired for 30 days.
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(actionTokens)
        .where(lt(actionTokens.expiresAt, cutoff!))
        .returning({ id: actionTokens.id })
      return removed.length
    },
  },

  sessions: {
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec.select({ n: N }).from(sessions).where(lt(sessions.expiresAt, cutoff!)),
        held: exec.select({ n: N }).from(sessions),
      }),
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(sessions)
        .where(lt(sessions.expiresAt, cutoff!))
        .returning({ id: sessions.id })
      return removed.length
    },
  },

  proposal_views: {
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(proposalViews)
          .where(lt(proposalViews.viewedAt, cutoff!)),
        held: exec.select({ n: N }).from(proposalViews),
      }),
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(proposalViews)
        .where(lt(proposalViews.viewedAt, cutoff!))
        .returning({ id: proposalViews.id })
      return removed.length
    },
  },

  lead_submissions: {
    // Only the ones that never became anything. An accepted submission is the
    // origin of an opportunity somebody is still working, and deleting it
    // would take the "where did this lead come from" answer with it.
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(leadSubmissions)
          .where(and(lt(leadSubmissions.receivedAt, cutoff!), unconverted())),
        held: exec.select({ n: N }).from(leadSubmissions),
      }),
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(leadSubmissions)
        .where(and(lt(leadSubmissions.receivedAt, cutoff!), unconverted()))
        .returning({ id: leadSubmissions.id })
      return removed.length
    },
  },

  campaign_events: {
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(campaignEvents)
          .where(lt(campaignEvents.occurredAt, cutoff!)),
        held: exec.select({ n: N }).from(campaignEvents),
      }),
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(campaignEvents)
        .where(lt(campaignEvents.occurredAt, cutoff!))
        .returning({ id: campaignEvents.id })
      return removed.length
    },
  },

  transactional_messages: {
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(transactionalMessages)
          .where(lt(transactionalMessages.createdAt, cutoff!)),
        held: exec.select({ n: N }).from(transactionalMessages),
      }),
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(transactionalMessages)
        .where(lt(transactionalMessages.createdAt, cutoff!))
        .returning({ id: transactionalMessages.id })
      return removed.length
    },
  },

  domain_events: {
    // `relayed_at IS NOT NULL` is the whole safety of this one. An event still
    // waiting to be relayed is work in progress, and an outbox that deletes
    // work in progress is not an outbox.
    count: (cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(domainEvents)
          .where(and(lt(domainEvents.occurredAt, cutoff!), isNotNull(domainEvents.relayedAt))),
        held: exec.select({ n: N }).from(domainEvents),
      }),
    remove: async (cutoff, exec) => {
      const removed = await exec
        .delete(domainEvents)
        .where(and(lt(domainEvents.occurredAt, cutoff!), isNotNull(domainEvents.relayedAt)))
        .returning({ id: domainEvents.id })
      return removed.length
    },
  },

  orphaned_blobs: {
    // Reachability, not age — and the counting half deliberately reports the
    // reference count rather than re-deriving reachability, because the
    // authoritative check is the one `sweepOrphanedBlobs` does row by row.
    count: (_cutoff, exec) =>
      tally(exec, {
        expired: exec
          .select({ n: N })
          .from(documentBlobs)
          .where(eq(documentBlobs.referenceCount, 0)),
        held: exec.select({ n: N }).from(documentBlobs),
      }),
    remove: (_cutoff, exec) => sweepOrphanedBlobs(exec),
  },
}

/**
 * A submission that never became an opportunity.
 *
 * The submission itself records what it created, so this is a null check
 * rather than a subquery — and it is the reason the policy can be as short as
 * six months: an accepted lead is somebody's live deal and is never swept,
 * however old the submission row is.
 */
function unconverted() {
  return isNull(leadSubmissions.createdOpportunityId)
}

/**
 * What every policy holds and what it would remove.
 *
 * Runs the counts and deletes nothing. This is what the operations page shows,
 * and what somebody answering "what do you hold about me" reads.
 */
export async function retentionReport(
  asOf: Date = new Date(),
  exec: Executor = db,
): Promise<RetentionCount[]> {
  const rows: RetentionCount[] = []

  for (const policy of RETENTION_POLICIES) {
    const counts = await SWEEPS[policy.kind].count(cutoffFor(policy, asOf), exec)
    rows.push({
      kind: policy.kind,
      label: policy.label,
      days: policy.days,
      publicallyWritten: policy.publicallyWritten,
      why: policy.why,
      ...counts,
    })
  }

  return rows
}

/** Runs one policy. */
export async function sweepOne(
  kind: RetentionKind,
  asOf: Date = new Date(),
  exec: Executor = db,
): Promise<SweepResult> {
  const policy = policyFor(kind)
  const removed = await SWEEPS[kind].remove(cutoffFor(policy, asOf), exec)
  return { kind, label: policy.label, removed }
}

/**
 * Runs every policy.
 *
 * One at a time rather than in parallel: this is housekeeping, it runs at 3am,
 * and nine concurrent ranged deletes competing for the same connection pool is
 * a way to make a quiet job noisy.
 */
export async function sweepAll(
  asOf: Date = new Date(),
  exec: Executor = db,
): Promise<SweepResult[]> {
  const results: SweepResult[] = []
  for (const policy of RETENTION_POLICIES) {
    results.push(await sweepOne(policy.kind, asOf, exec))
  }
  return results
}

export type { RetentionPolicy }
