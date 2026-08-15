import Link from 'next/link'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { SETTINGS_NAV } from '../nav'
import { listJobs, oldestQueuedAt, queueCounts } from '@/modules/worker/queue'
import { listSchedules } from '@/modules/worker/schedules'
import { listEvents, pendingEventCount } from '@/modules/worker/outbox'
import { registeredKinds } from '@/modules/worker/registry'
import { workerStatuses } from '@/modules/worker/runner'
import { listDraftEntries } from '@/modules/ledger/journal'
import '@/modules/worker/handlers'
import { OperationsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The operations page (spec §18).
 *
 * ## Why a queue needs a page at all
 *
 * Because "the queue is empty" and "nothing is draining the queue" look
 * identical from every other screen in the product, and the second is an
 * outage that presents as calm. A campaign that never went out, a remittance
 * reminder that never fired, a WIP proposal that never appeared — none of
 * those raise an error anywhere. They are absences, and an absence is only
 * visible against something that says what should have been there.
 *
 * So this page leads with whether a worker is alive, and then with what
 * failed. The successful jobs are last, because they are the least useful
 * thing on it.
 */
export default async function OperationsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'operations:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Background work</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include seeing the background queue.
        </p>
      </main>
    )
  }

  const [counts, workers, jobs, schedules, events, pendingEvents, oldest, drafts] =
    await Promise.all([
      queueCounts(actor.companyId),
      workerStatuses(),
      listJobs({ companyId: actor.companyId, limit: 60 }),
      listSchedules(actor.companyId),
      listEvents(actor.companyId, 25),
      pendingEventCount(actor.companyId),
      oldestQueuedAt(actor.companyId),
      can(actor, 'accounting:view') ? listDraftEntries(actor, { limit: 20 }) : Promise.resolve([]),
    ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="bookkeeping"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/operations" />

      <OperationsBoard
        counts={counts}
        workers={workers.map((worker) => ({
          workerId: worker.workerId,
          hostname: worker.hostname,
          lastSeenAt: worker.lastSeenAt.toISOString(),
          jobsProcessed: worker.jobsProcessed,
          isAlive: worker.isAlive,
        }))}
        oldestQueuedAt={oldest?.toISOString() ?? null}
        pendingEvents={pendingEvents}
        jobs={jobs.map((job) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          runAt: job.runAt.toISOString(),
          lastError: job.lastError,
          result: job.result,
          isGlobal: job.companyId === null,
          createdAt: job.createdAt.toISOString(),
        }))}
        schedules={schedules.map((schedule) => ({
          id: schedule.id,
          kind: schedule.kind,
          cadence: schedule.cadence,
          hourUtc: schedule.hourUtc,
          isActive: schedule.isActive,
          nextRunAt: schedule.nextRunAt.toISOString(),
          lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
        }))}
        events={events.map((event) => ({
          id: event.id,
          type: event.type,
          entityType: event.entityType,
          occurredAt: event.occurredAt.toISOString(),
          relayedAt: event.relayedAt?.toISOString() ?? null,
          lastError: event.lastError,
        }))}
        drafts={drafts.map((entry) => ({
          id: entry.id,
          entryNumber: entry.entryNumber,
          entryDate: entry.entryDate,
          memo: entry.memo,
          sourceType: entry.sourceType,
        }))}
        handlers={registeredKinds().map((entry) => ({
          kind: entry.kind,
          label: entry.label,
          global: Boolean(entry.global),
        }))}
        canManage={can(actor, 'operations:manage')}
        canPostEntries={can(actor, 'accounting:journal')}
      />

      <p className="mt-4 text-xs text-faint">
        Jobs run <strong>at least once</strong>, never exactly once — a worker can be killed
        between finishing work and recording that it finished, and no arrangement of tables closes
        that window. Every handler is written to be safe run twice, which is the same discipline the
        mobile app has followed since Phase 8. See{' '}
        <Link href="/settings/modules" className="underline">
          modules
        </Link>{' '}
        for what is switched on for this company.
      </p>
    </AppShell>
  )
}
