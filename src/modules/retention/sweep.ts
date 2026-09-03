import { and, eq, getTableName, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db, type Executor } from '@/db'
import {
  actionTokens,
  campaignEvents,
  documentBlobs,
  domainEvents,
  guardAttempts,
  integrityRuns,
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
import { ATTRIBUTIONS, showingFor, type Audience, type Showing } from './attribution'

/**
 * Doing what the policy says (spec §19).
 *
 * ## Counting is a separate query from deleting, on purpose
 *
 * Every policy has an age predicate and a count, and the operations page runs
 * the counts. Somebody is entitled to see what a retention policy would take
 * before it takes it — a number nobody can check before the delete is a number
 * nobody can dispute after it.
 *
 * ## Every sweep is safe to run at any time, twice
 *
 * They are ranged deletes on a cutoff, so a second run deletes nothing and a
 * half-finished run leaves the rest for the next one. No sweep needs the
 * previous one to have succeeded, which is what lets the schedule be dumb.
 *
 * ## The report has an audience and the sweep does not (Phase 102)
 *
 * `retentionReport` takes a caller-supplied audience — a company, or the
 * deployment — because the operations page showing it belongs to one company,
 * and it used to show every company's numbers to all of them.
 *
 * `sweepAll` deliberately keeps no audience. "Scope it like everything else"
 * applied to the delete would be a serious bug: retention would then only
 * remove rows belonging to whoever last loaded a page. Deleting is housekeeping
 * that runs nightly as nobody; reporting is a screen somebody is looking at.
 * Only the second has a viewer.
 *
 * ## Why each policy is data rather than two hand-written queries
 *
 * A policy declares its table, the column a company is reached by (or null),
 * and what makes a row expired. **The company filter is then applied in exactly
 * one place** — `countFor` below. The alternative, threading a scope argument
 * into eleven hand-written count closures, gives eleven chances to forget it,
 * and forgetting it is precisely the defect Phase 102 exists to fix.
 */

export type SweepResult = {
  kind: RetentionKind
  label: string
  removed: number
}

/** The half of a policy that is a published statement about the product. */
type PolicyFacts = {
  kind: RetentionKind
  label: string
  days: number | null
  publicallyWritten: boolean
  why: string
}

/**
 * A policy as one viewer sees it.
 *
 * The counts are inside the `counted: true` arm rather than nullable numbers
 * beside a flag, so nothing can read `held` without having checked whether this
 * viewer is entitled to it — the check is the type, not a convention.
 */
export type RetentionCount = PolicyFacts &
  (
    | {
        counted: true
        /** False when this is the viewer's own share rather than the total. */
        whole: boolean
        caveat: string | null
        /** Rows the policy would remove if it ran now. */
        expired: number
        /** Rows it is holding, which is the half a privacy question asks about. */
        held: number
      }
    | { counted: false; because: string }
  )

type Sweep = {
  table: PgTable
  /**
   * The column a company is reached by, or null when the rows have no company
   * at all. Cross-checked against `ATTRIBUTIONS` and against
   * `information_schema` in `tests/retention-attribution.test.ts`.
   */
  company: PgColumn | null
  /** What makes a row expired, with no company filter in it. */
  expired: (cutoff: Date | null) => SQL | undefined
  /** Only where deleting is not simply "delete what is expired". */
  remove?: (cutoff: Date | null, exec: Executor) => Promise<number>
}

const N = sql<string>`count(*)`

const SWEEPS: Record<RetentionKind, Sweep> = {
  login_attempts: {
    table: loginAttempts,
    company: null,
    expired: (cutoff) => lt(loginAttempts.createdAt, cutoff!),
  },

  action_tokens: {
    table: actionTokens,
    company: actionTokens.companyId,
    // Measured from the token's expiry rather than its creation — a week-long
    // invitation issued 29 days ago has not been expired for 30 days.
    expired: (cutoff) => lt(actionTokens.expiresAt, cutoff!),
  },

  sessions: {
    table: sessions,
    company: null,
    expired: (cutoff) => lt(sessions.expiresAt, cutoff!),
  },

  proposal_views: {
    table: proposalViews,
    company: proposalViews.companyId,
    expired: (cutoff) => lt(proposalViews.viewedAt, cutoff!),
  },

  lead_submissions: {
    table: leadSubmissions,
    company: leadSubmissions.companyId,
    // Only the ones that never became anything. An accepted submission is the
    // origin of an opportunity somebody is still working, and deleting it
    // would take the "where did this lead come from" answer with it.
    expired: (cutoff) =>
      and(lt(leadSubmissions.receivedAt, cutoff!), isNull(leadSubmissions.createdOpportunityId)),
  },

  campaign_events: {
    table: campaignEvents,
    company: campaignEvents.companyId,
    expired: (cutoff) => lt(campaignEvents.occurredAt, cutoff!),
  },

  transactional_messages: {
    table: transactionalMessages,
    company: transactionalMessages.companyId,
    expired: (cutoff) => lt(transactionalMessages.createdAt, cutoff!),
  },

  domain_events: {
    table: domainEvents,
    company: domainEvents.companyId,
    // `relayed_at IS NOT NULL` is the whole safety of this one. An event still
    // waiting to be relayed is work in progress, and an outbox that deletes
    // work in progress is not an outbox.
    expired: (cutoff) =>
      and(lt(domainEvents.occurredAt, cutoff!), isNotNull(domainEvents.relayedAt)),
  },

  orphaned_blobs: {
    table: documentBlobs,
    company: null,
    // Reachability, not age — and the counting half reports the reference
    // count rather than re-deriving reachability, because the authoritative
    // check is the one `sweepOrphanedBlobs` does row by row.
    expired: () => eq(documentBlobs.referenceCount, 0),
    remove: (_cutoff, exec) => sweepOrphanedBlobs(exec),
  },

  integrity_runs: {
    table: integrityRuns,
    company: integrityRuns.companyId,
    // Findings are deleted by the foreign key rather than by a second policy,
    // which is why only the run table is named. One policy, one table, and the
    // allowlist stays the whole truth about what this module can reach.
    expired: (cutoff) => lt(integrityRuns.startedAt, cutoff!),
  },

  guard_attempts: {
    table: guardAttempts,
    company: null,
    // Every row, right and wrong alike. The successful ones are what clear a
    // run of failures inside the cool-off window, and a sweep on a year-old
    // cutoff cannot reach anything the fifteen-minute window is still reading.
    expired: (cutoff) => lt(guardAttempts.createdAt, cutoff!),
  },
}

/**
 * The one place a company filter is applied.
 *
 * `scope` is folded into both queries — the expired count and the held count —
 * so a policy cannot end up reporting one company's expiring rows against every
 * company's total.
 */
async function countFor(
  sweep: Sweep,
  cutoff: Date | null,
  audience: Audience,
  exec: Executor,
): Promise<{ expired: number; held: number }> {
  const scope =
    audience.kind === 'company' && sweep.company
      ? eq(sweep.company, audience.companyId)
      : undefined

  const table = sweep.table as never

  const [expired, held] = await Promise.all([
    exec
      .select({ n: N })
      .from(table)
      .where(and(sweep.expired(cutoff), scope)) as Promise<Array<{ n: string }>>,
    exec.select({ n: N }).from(table).where(scope) as Promise<Array<{ n: string }>>,
  ])

  return { expired: Number(expired[0]?.n ?? 0), held: Number(held[0]?.n ?? 0) }
}

function factsOf(policy: RetentionPolicy): PolicyFacts {
  return {
    kind: policy.kind,
    label: policy.label,
    days: policy.days,
    publicallyWritten: policy.publicallyWritten,
    why: policy.why,
  }
}

function withShowing(
  facts: PolicyFacts,
  showing: Showing,
  counts: { expired: number; held: number },
): RetentionCount {
  if (!showing.counted) return { ...facts, counted: false, because: showing.because }

  return {
    ...facts,
    counted: true,
    whole: showing.whole,
    caveat: showing.whole ? null : showing.caveat,
    ...counts,
  }
}

/**
 * What every policy holds and what it would remove, for one viewer.
 *
 * `audience` is required rather than defaulted. A default would be a decision
 * made once by whoever wrote this line and inherited silently by every caller
 * after — which is exactly how the operations page came to show one company
 * every other company's numbers.
 *
 * Runs the counts and deletes nothing. This is what the operations page shows,
 * and what somebody answering "what do you hold about me" reads.
 */
export async function retentionReport(
  audience: Audience,
  asOf: Date = new Date(),
  exec: Executor = db,
): Promise<RetentionCount[]> {
  const rows: RetentionCount[] = []

  for (const policy of RETENTION_POLICIES) {
    const facts = factsOf(policy)
    const showing = showingFor(ATTRIBUTIONS[policy.kind], audience)

    if (!showing.counted) {
      rows.push({ ...facts, counted: false, because: showing.because })
      continue
    }

    const counts = await countFor(SWEEPS[policy.kind], cutoffFor(policy, asOf), audience, exec)
    rows.push(withShowing(facts, showing, counts))
  }

  return rows
}

/** Runs one policy. Deletes across every company, always — see the docstring. */
export async function sweepOne(
  kind: RetentionKind,
  asOf: Date = new Date(),
  exec: Executor = db,
): Promise<SweepResult> {
  const policy = policyFor(kind)
  const sweep = SWEEPS[kind]
  const cutoff = cutoffFor(policy, asOf)

  const removed = sweep.remove
    ? await sweep.remove(cutoff, exec)
    : (
        await (exec.delete(sweep.table as never) as never as {
          where: (w: SQL | undefined) => { returning: () => Promise<unknown[]> }
        })
          .where(sweep.expired(cutoff))
          .returning()
      ).length

  return { kind, label: policy.label, removed }
}

/**
 * Runs every policy.
 *
 * One at a time rather than in parallel: this is housekeeping, it runs at 3am,
 * and a pile of concurrent ranged deletes competing for the same connection
 * pool is a way to make a quiet job noisy.
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

/** The company column each policy filters on, for the catalogue tripwire. */
export function companyColumnNames(): Record<RetentionKind, string | null> {
  const names = {} as Record<RetentionKind, string | null>
  for (const kind of Object.keys(SWEEPS) as RetentionKind[]) {
    names[kind] = SWEEPS[kind].company?.name ?? null
  }
  return names
}

/**
 * The table each policy actually reads and deletes from.
 *
 * Taken from the drizzle table object rather than from `RetentionPolicy.table`,
 * which is a hand-written string. The two are asserted equal in
 * `tests/retention-attribution.test.ts`, and that check is not decorative:
 * Phase 24's safety property — "no policy names a table that holds the books" —
 * is asserted against the *string*, so a sweep pointed at a different table
 * than its policy names would make that guarantee vacuous.
 */
export function sweptTableNames(): Record<RetentionKind, string> {
  const names = {} as Record<RetentionKind, string>
  for (const kind of Object.keys(SWEEPS) as RetentionKind[]) {
    names[kind] = getTableName(SWEEPS[kind].table)
  }
  return names
}

export type { RetentionPolicy }
