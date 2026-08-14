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
