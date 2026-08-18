'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  cancelJobAction,
  discardDraftEntryAction,
  postDraftEntryAction,
  retryJobAction,
  runNowAction,
  setScheduleActiveAction,
  tickWorkerAction,
} from '@/app/actions/operations'
import { formatCents } from '@/lib/money'

type Counts = Record<string, number>

type Worker = {
  workerId: string
  hostname: string | null
  lastSeenAt: string
  jobsProcessed: number
  isAlive: boolean
}

type Job = {
  id: string
  kind: string
  status: string
  attempts: number
  maxAttempts: number
  runAt: string
  lastError: string | null
  result: Record<string, unknown> | null
  isGlobal: boolean
  createdAt: string
}

type Schedule = {
  id: string
  kind: string
  cadence: string
  hourUtc: number
  isActive: boolean
  nextRunAt: string
  lastRunAt: string | null
}

type DomainEventRow = {
  id: string
  type: string
  entityType: string | null
  occurredAt: string
  relayedAt: string | null
  lastError: string | null
}

type Draft = {
  id: string
  entryNumber: number
  entryDate: string
  memo: string | null
  sourceType: string | null
}

type Handler = { kind: string; label: string; global: boolean }

type Failures = {
  since: string
  total: number
  deadJobs: Array<{
    id: string
    kind: string
    lastError: string | null
    attempts: number
    finishedAt: string | null
  }>
  bouncedMail: Array<{
    id: string
    kind: string
    email: string
    subject: string
    error: string | null
    createdAt: string
  }>
} | null

type Integrity = {
  asOf: string
  startedAt: string
  checksRun: number
  checksSkipped: number
  faults: number
  errors: number
  findings: Array<{
    key: string
    label: string
    severity: string
    agrees: boolean
    leftCents: number
    rightCents: number
    differenceCents: number
    detail: string | null
    error: string | null
    meaning: string
    compares: string
  }>
} | null

type Retention = Array<{
  kind: string
  label: string
  days: number | null
  publicallyWritten: boolean
  why: string
  expired: number
  held: number
}> | null

/**
 * The operations board.
 *
 * Ordered by how bad the thing is. Whether a worker is alive comes first,
 * because if none is then nothing below it means what it appears to; then dead
 * jobs, then proposals waiting on a person, then the routine listings. The
 * successful jobs are last — they are the least useful rows on the page.
 */
export function OperationsBoard({
  counts,
  workers,
  oldestQueuedAt,
  pendingEvents,
  jobs,
  schedules,
  events,
  drafts,
  handlers,
  failures,
  retention,
  integrity,
  canSeeIntegrity,
  canManage,
  canPostEntries,
}: {
  counts: Counts
  workers: Worker[]
  oldestQueuedAt: string | null
  pendingEvents: number
  jobs: Job[]
  schedules: Schedule[]
  events: DomainEventRow[]
  drafts: Draft[]
  handlers: Handler[]
  failures: Failures
  retention: Retention
  integrity: Integrity
  /**
   * Whether this reader may see the books check at all.
   *
   * Separate from `integrity` being null, because a bookkeeper has
   * `operations:view` and not `reports:financial` — and telling them the books
   * have never been checked when they simply cannot see the answer would be a
   * false statement, not a missing one.
   */
  canSeeIntegrity: boolean
  canManage: boolean
  canPostEntries: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
        ok: result.ok,
      })
      if (result.ok) router.refresh()
    })
  }

  const alive = workers.filter((worker) => worker.isAlive)
  const dead = jobs.filter((job) => job.status === 'dead')
  const failing = jobs.filter((job) => job.status === 'failed')
  const rest = jobs.filter((job) => job.status !== 'dead' && job.status !== 'failed')

  const behindMinutes = oldestQueuedAt
    ? Math.floor((Date.now() - Date.parse(oldestQueuedAt)) / 60_000)
    : 0

  return (
    <div className="space-y-4">
      {message && (
        <p className={`card p-3 text-sm ${message.ok ? 'text-positive' : 'text-negative'}`} role="status">
          {message.text}
        </p>
      )}

      {/* Is anything running at all? */}
      {alive.length === 0 ? (
        <section className="card border-negative/40 p-4">
          <h2 className="text-sm font-semibold text-negative">No worker is running.</h2>
          <p className="mt-1 text-sm text-muted">
            Nothing in the queue will run. Campaigns will not send, reminders will not fire, and
            the WIP entry will not be proposed — none of which raises an error anywhere else,
            which is the reason this page exists.
          </p>
          <p className="mt-2 text-xs text-faint">
            Start one with <code>npm run worker</code>. Several can run at once; they claim
            different jobs rather than the same one.
          </p>
          {canManage && (
            <button
              className="btn btn-primary mt-3 text-xs"
              disabled={pending}
              onClick={() => act(() => tickWorkerAction())}
            >
              {pending ? 'Running…' : 'Run one tick from here'}
            </button>
          )}
        </section>
      ) : (
        <section className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                <span className="text-positive">
                  {alive.length} {alive.length === 1 ? 'worker' : 'workers'} running
                </span>
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                {alive
                  .map(
                    (worker) =>
                      `${worker.hostname ?? worker.workerId} — ${worker.jobsProcessed} jobs`,
                  )
                  .join(' · ')}
              </p>
            </div>
            {canManage && (
              <button
                className="btn text-xs"
                disabled={pending}
                onClick={() => act(() => tickWorkerAction())}
              >
                Run a tick now
              </button>
            )}
          </div>
        </section>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Queued" value={counts.queued ?? 0} />
        <Stat label="Running" value={counts.running ?? 0} />
        <Stat label="Retrying" value={counts.failed ?? 0} tone={counts.failed > 0 ? 'warn' : undefined} />
        <Stat label="Dead" value={counts.dead ?? 0} tone={counts.dead > 0 ? 'bad' : undefined} />
        <Stat label="Succeeded" value={counts.succeeded ?? 0} />
        <Stat
          label="Events waiting"
          value={pendingEvents}
          tone={pendingEvents > 0 ? 'warn' : undefined}
        />
      </div>

      {behindMinutes > 10 && (
        <p className="card border-warning/40 p-3 text-sm">
          <span className="font-medium text-warning">
            The oldest due job has been waiting {behindMinutes} minutes.
          </span>{' '}
          A worker may have stopped, or one job kind may be holding the batch.
        </p>
      )}

      {/* What is broken */}
      {dead.length > 0 && (
        <Card
          title={`${dead.length} ${dead.length === 1 ? 'job has' : 'jobs have'} given up`}
          subtitle="Out of attempts. Nothing retries these on its own — that is deliberate, because a job retrying forever hides the healthy queue behind it."
        >
          <JobList
            jobs={dead}
            expanded={expanded}
            onToggle={setExpanded}
            canManage={canManage}
            pending={pending}
            onRetry={(id) => act(() => retryJobAction(id))}
            onCancel={(id) => act(() => cancelJobAction(id))}
          />
        </Card>
      )}

      {canSeeIntegrity && <IntegritySection integrity={integrity} />}

      {failing.length > 0 && (
        <Card
          title={`${failing.length} retrying`}
          subtitle="Failed and will be attempted again, with the delay doubling each time."
        >
          <JobList
            jobs={failing}
            expanded={expanded}
            onToggle={setExpanded}
            canManage={canManage}
            pending={pending}
            onRetry={(id) => act(() => retryJobAction(id))}
            onCancel={(id) => act(() => cancelJobAction(id))}
          />
        </Card>
      )}

      {failures && failures.bouncedMail.length > 0 && (
        <Card
          title={`${failures.bouncedMail.length} ${failures.bouncedMail.length === 1 ? 'letter' : 'letters'} did not arrive`}
          subtitle="Recorded since Phase 19 and shown to nobody until now. An invitation to a mistyped address fails silently otherwise — the person waiting simply never hears."
        >
          <ul className="divide-y divide-line text-sm">
            {failures.bouncedMail.map((mail) => (
              <li key={mail.id} className="px-4 py-2">
                <p>
                  <span className="font-medium">{mail.email}</span>
                  <span className="text-xs text-faint"> · {mail.kind.replace(/_/g, ' ')}</span>
                </p>
                <p className="text-xs text-muted">{mail.subject}</p>
                {mail.error && <p className="text-xs text-negative">{mail.error}</p>}
                <p className="text-xs text-faint">{mail.createdAt.slice(0, 10)}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Waiting on a person */}
      {drafts.length > 0 && (
        <Card
          title={`${drafts.length} proposed ${drafts.length === 1 ? 'entry' : 'entries'} waiting for a decision`}
          subtitle="Written by a scheduled task, balanced and validated, and affecting no report until somebody posts one. A machine can work out the entry; it must not put it in the books unasked."
        >
          <ul className="divide-y divide-line">
            {drafts.map((draft) => (
              <li key={draft.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    Entry {draft.entryNumber} — {draft.entryDate}
                    {draft.sourceType && (
                      <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                        {draft.sourceType.replace('_', ' ')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">{draft.memo}</p>
                </div>
                {canPostEntries && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      className="btn btn-primary px-2 py-1 text-xs"
                      disabled={pending}
                      onClick={() => act(() => postDraftEntryAction(draft.id))}
                    >
                      Post it
                    </button>
                    <button
                      className="btn px-2 py-1 text-xs"
                      disabled={pending}
                      onClick={() => act(() => discardDraftEntryAction(draft.id))}
                    >
                      Discard
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* The routine listings */}
      <Card
        title="Schedules"
        subtitle="Cadence and an hour rather than cron — a cron typo means 'never' rather than an error, and a schedule that silently never fires is worse than one that cannot express every timing."
      >
        {schedules.length === 0 ? (
          <Empty>Nothing scheduled for this company.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {schedules.map((schedule) => (
              <li
                key={schedule.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {handlers.find((h) => h.kind === schedule.kind)?.label ?? schedule.kind}
                    {!schedule.isActive && (
                      <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                        paused
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-faint">
                    {schedule.cadence}
                    {schedule.cadence !== 'hourly' && ` at ${String(schedule.hourUtc).padStart(2, '0')}:00 UTC`}
                    {' · next '}
                    {new Date(schedule.nextRunAt).toISOString().slice(0, 16).replace('T', ' ')}
                    {schedule.lastRunAt &&
                      ` · last ${new Date(schedule.lastRunAt).toISOString().slice(0, 16).replace('T', ' ')}`}
                  </p>
                </div>
                {canManage && (
                  <button
                    className="btn px-2 py-1 text-xs"
                    disabled={pending}
                    onClick={() => act(() => setScheduleActiveAction(schedule.id, !schedule.isActive))}
                  >
                    {schedule.isActive ? 'Pause' : 'Resume'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Events"
        subtitle="Written inside the transaction that caused them, so an event and the change it describes cannot come apart. Relayed into jobs afterwards."
      >
        {events.length === 0 ? (
          <Empty>Nothing has happened yet that anybody subscribed to.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{event.type}</span>
                  {event.entityType && <span className="ml-2 text-faint">{event.entityType}</span>}
                </span>
                <span className="shrink-0 text-xs">
                  {event.relayedAt ? (
                    <span className="text-muted">relayed</span>
                  ) : event.lastError ? (
                    <span className="text-negative">{event.lastError.slice(0, 60)}</span>
                  ) : (
                    <span className="text-warning">waiting</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {rest.length > 0 && (
        <Card title="Recent jobs" subtitle="Newest first.">
          <JobList
            jobs={rest}
            expanded={expanded}
            onToggle={setExpanded}
            canManage={canManage}
            pending={pending}
            onRetry={(id) => act(() => retryJobAction(id))}
            onCancel={(id) => act(() => cancelJobAction(id))}
          />
        </Card>
      )}

      {canManage && (
        <Card
          title="Run something now"
          subtitle="Queues it ahead of the routine work rather than running it inline — so it goes through the same retry, de-duplication, and visibility as everything else."
        >
          <div className="flex flex-wrap gap-2 p-4">
            {handlers.map((handler) => (
              <button
                key={handler.kind}
                className="btn text-xs"
                disabled={pending}
                title={handler.kind}
                onClick={() => act(() => runNowAction(handler.kind))}
              >
                {handler.label}
                {handler.global && <span className="ml-1 text-faint">(all companies)</span>}
              </button>
            ))}
          </div>
        </Card>
      )}

      {retention && (
        <Card
          title="What is kept, and for how long"
          subtitle="Every table this application lets grow with traffic. Nothing here can reach the ledger, the audit log, or a document — the policy is an allowlist, and the suite fails if the books ever appear on it."
        >
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Kept</th>
                <th className="px-4 py-2 font-medium">For</th>
                <th className="px-4 py-2 text-right font-medium">Holding</th>
                <th className="px-4 py-2 text-right font-medium">Would remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {retention.map((policy) => (
                <tr key={policy.kind}>
                  <td className="px-4 py-2">
                    <p className="font-medium">{policy.label}</p>
                    <p className="text-xs text-muted">{policy.why}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs">
                    {policy.days === null ? (
                      <span className="text-faint">until unreachable</span>
                    ) : (
                      `${policy.days} days`
                    )}
                    {policy.publicallyWritten && (
                      <span
                        className="block text-faint"
                        title="Rows arrive from unauthenticated strangers, which is what makes the retention a control rather than tidiness."
                      >
                        written by the public
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{policy.held}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className={policy.expired > 0 ? 'text-warning' : 'text-faint'}>
                      {policy.expired}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function JobList({
  jobs,
  expanded,
  onToggle,
  canManage,
  pending,
  onRetry,
  onCancel,
}: {
  jobs: Job[]
  expanded: string | null
  onToggle: (id: string | null) => void
  canManage: boolean
  pending: boolean
  onRetry: (id: string) => void
  onCancel: (id: string) => void
}) {
  return (
    <ul className="divide-y divide-line">
      {jobs.map((job) => (
        <li key={job.id} className="px-4 py-2.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <button
              className="min-w-0 text-left"
              onClick={() => onToggle(expanded === job.id ? null : job.id)}
            >
              <p className="text-sm font-medium">
                {job.kind}
                {job.isGlobal && (
                  <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                    all companies
                  </span>
                )}
              </p>
              <p className="text-xs text-faint">
                <StatusChip status={job.status} /> · attempt {job.attempts}/{job.maxAttempts} ·{' '}
                {new Date(job.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
              </p>
              {job.lastError && (
                <p className="mt-0.5 text-xs text-negative">{job.lastError.slice(0, 140)}</p>
              )}
            </button>

            {canManage && (job.status === 'dead' || job.status === 'failed' || job.status === 'queued') && (
              <div className="flex shrink-0 gap-2">
                {job.status !== 'queued' && (
                  <button
                    className="btn px-2 py-1 text-xs"
                    disabled={pending}
                    onClick={() => onRetry(job.id)}
                  >
                    Retry
                  </button>
                )}
                <button
                  className="btn px-2 py-1 text-xs"
                  disabled={pending}
                  onClick={() => onCancel(job.id)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {expanded === job.id && (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-raised p-3 text-xs">
              {JSON.stringify(job.result ?? { note: 'No result recorded.' }, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ul>
  )
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'dead'
      ? 'text-negative'
      : status === 'failed'
        ? 'text-warning'
        : status === 'succeeded'
          ? 'text-positive'
          : 'text-muted'

  return <span className={tone}>{status}</span>
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'bad' }) {
  const toneClass = tone === 'bad' ? 'text-negative' : tone === 'warn' ? 'text-warning' : ''

  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}

/**
 * What the nightly books check found (Phase 33).
 *
 * The three outcomes are kept visually apart because they are three different
 * problems: **these disagree**, **nobody knows whether these agree**, and
 * **this was never asked**. A page that showed a green tick for a check whose
 * module is off, or for one that threw, would be worse than no page.
 *
 * "Never run" gets its own state and says so, because "no findings" and "the
 * scheduled job stopped firing three weeks ago" look identical otherwise — and
 * that confusion is the whole reason this phase exists.
 */
function IntegritySection({ integrity }: { integrity: Integrity }) {
  if (!integrity) {
    return (
      <Card
        title="The books have never been checked"
        subtitle="A nightly job runs every reconciliation this application has. Nothing has run one yet — which is not the same as nothing being wrong."
      >
        <Empty>
          Run <code className="text-xs">books.integrity_check</code> from the schedules below, or
          wait for 2am.
        </Empty>
      </Card>
    )
  }

  // Three disjoint groups, and the disjointness is load-bearing: a *position*
  // that threw is broken (nobody knows whether it agrees) and must appear once,
  // under that heading, not once in each list with the same React key.
  const isBrokenRow = (row: (typeof integrity.findings)[number]) =>
    Boolean(row.error) || (row.severity === 'fault' && !row.agrees)

  const broken = integrity.findings.filter(isBrokenRow)
  const rest = integrity.findings.filter((row) => !isBrokenRow(row))
  const positions = rest.filter((row) => row.severity === 'position')
  const clean = rest.filter((row) => row.severity === 'fault')

  return (
    <Card
      title={
        broken.length === 0
          ? `The books agree with themselves (${clean.length} checks)`
          : `${broken.length} ${broken.length === 1 ? 'check has' : 'checks have'} stopped agreeing`
      }
      subtitle={
        `As at ${integrity.asOf}, run ${integrity.startedAt.slice(0, 16).replace('T', ' ')}. ` +
        `${integrity.checksRun} run` +
        (integrity.checksSkipped > 0
          ? `, ${integrity.checksSkipped} skipped because their module is switched off — which is not the same as passing.`
          : '.')
      }
    >
      <ul className="divide-y divide-line text-sm">
        {[...broken, ...positions, ...clean].map((row) => (
          <li className="px-4 py-3" key={row.key}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">
                {row.label}
                {row.severity === 'position' && (
                  <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                    a position, not a fault
                  </span>
                )}
              </p>
              <Verdict row={row} />
            </div>
            <p className="text-xs text-faint">{row.compares}</p>
            {row.error ? (
              <p className="mt-1 text-xs text-danger">
                The check itself did not finish, so nothing was proved: {row.error}
              </p>
            ) : (
              !row.agrees && <p className="mt-1 text-xs text-muted">{row.meaning}</p>
            )}
            {row.detail && !row.error && <p className="mt-1 text-xs text-faint">{row.detail}</p>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Verdict({
  row,
}: {
  row: { agrees: boolean; error: string | null; severity: string; differenceCents: number }
}) {
  if (row.error) {
    return <span className="text-xs text-danger">could not be checked</span>
  }
  if (row.agrees) {
    return <span className="text-xs text-success">agrees</span>
  }

  const amount = formatCents(Math.abs(row.differenceCents))

  // A position that differs is information; a fault that differs is an
  // accusation. Same number, deliberately different words.
  return row.severity === 'position' ? (
    <span className="tnum text-xs text-muted">{amount} apart</span>
  ) : (
    <span className="tnum text-xs text-danger">{amount} apart</span>
  )
}
