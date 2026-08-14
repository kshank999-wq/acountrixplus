import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { domainEvents, journalEntries, users } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import {
  backoffMs,
  BASE_DELAY_MS,
  claimExpired,
  CLAIM_TIMEOUT_MS,
  MAX_DELAY_MS,
  nextAttemptAt,
} from '@/modules/worker/backoff'
import {
  cancelJob,
  claimJobs,
  completeJob,
  enqueue,
  failJob,
  listJobs,
  pruneFinishedJobs,
  queueCounts,
  retryJob,
} from '@/modules/worker/queue'
import { nextRunAt, runDueSchedules, upsertSchedule } from '@/modules/worker/schedules'
import { recordEvent, relayPendingEvents, pendingEventCount } from '@/modules/worker/outbox'
import { registerHandler, getHandler, registeredKinds } from '@/modules/worker/registry'
import { runOnce, workerStatuses, HEARTBEAT_STALE_MS } from '@/modules/worker/runner'
import {
  isSystemActor,
  systemActor,
  SYSTEM_USER_EMAIL,
  SYSTEM_USER_NAME,
} from '@/modules/worker/system-actor'
import { verifyPassword } from '@/modules/auth/password'
import { draftJournalEntry, discardDraftEntry, listDraftEntries, postDraftEntry } from '@/modules/ledger/journal'
import { trialBalance } from '@/modules/ledger/balances'
import '@/modules/worker/handlers'

/**
 * Phase 10 (spec §18: background worker/queue, event/outbox pattern).
 *
 * The claim being tested is narrow and it is the one everything else leans on:
 * **a job runs at least once, and running it twice is safe.** Most of what
 * follows is that sentence checked from a different angle.
 */

// A handler registered only for the tests, so a test's failure is its own
// rather than a real handler's.
let probeRuns = 0
let probeShouldThrow = false

registerHandler({
  kind: 'test.probe',
  label: 'Test probe',
  handler: async (context) => {
    probeRuns++
    if (probeShouldThrow) throw new Error('probe failed on purpose')
    return { ran: probeRuns, company: context.companyId }
  },
})

registerHandler({
  kind: 'test.global_probe',
  label: 'Test global probe',
  global: true,
  handler: async (context) => ({ hadActor: context.actor !== null }),
})

describe('backoff', () => {
  it('grows exponentially from the base delay', () => {
    const noJitter = () => 0

    expect(backoffMs(1, noJitter)).toBe(BASE_DELAY_MS)
    expect(backoffMs(2, noJitter)).toBe(BASE_DELAY_MS * 2)
    expect(backoffMs(3, noJitter)).toBe(BASE_DELAY_MS * 4)
    expect(backoffMs(4, noJitter)).toBe(BASE_DELAY_MS * 8)
  })

  it('never waits longer than the cap, however many failures', () => {
    // Without a cap, attempt 20 would be about three years.
    expect(backoffMs(20, () => 0)).toBe(MAX_DELAY_MS)
    expect(backoffMs(100, () => 1)).toBeLessThanOrEqual(MAX_DELAY_MS * 1.25)
  })

  it('jitters upward only', () => {
    // A provider outage fails every queued job at once. Without jitter they
    // retry in lockstep and hit the still-broken provider together; retrying
    // *earlier* than the policy is the one direction that cannot help.
    const base = backoffMs(3, () => 0)

    expect(backoffMs(3, () => 1)).toBeGreaterThan(base)
    expect(backoffMs(3, () => 0.5)).toBeGreaterThan(base)
    expect(backoffMs(3, () => 0)).toBe(base)
  })

  it('pushes the next attempt into the future', () => {
    const now = new Date('2026-08-13T12:00:00Z')
    expect(nextAttemptAt(1, now, () => 0).getTime()).toBe(now.getTime() + BASE_DELAY_MS)
  })

  it('treats a never-locked job as claimable', () => {
    const now = new Date('2026-08-13T12:00:00Z')

    expect(claimExpired(null, now)).toBe(true)
    expect(claimExpired(new Date(now.getTime() - 1_000), now)).toBe(false)
    expect(claimExpired(new Date(now.getTime() - CLAIM_TIMEOUT_MS - 1), now)).toBe(true)
  })
})

describe('the queue', () => {
  it('claims a due job exactly once across concurrent workers', async () => {
    const fixture = await createCompanyFixture()

    await enqueue({ kind: 'test.probe', companyId: fixture.companyId })

    // Two workers polling at the same instant. Without SKIP LOCKED this either
    // blocks or hands the same row to both.
    const [first, second] = await Promise.all([
      claimJobs('worker-a', 5),
      claimJobs('worker-b', 5),
    ])

    const claimed = [...first, ...second]
    expect(claimed).toHaveLength(1)
  })

  it('leaves a job alone until its run_at', async () => {
    const fixture = await createCompanyFixture()
    const later = new Date(Date.now() + 60 * 60 * 1000)

    await enqueue({ kind: 'test.probe', companyId: fixture.companyId, runAt: later })

    expect(await claimJobs('worker-a')).toHaveLength(0)
    // Asked as though an hour had passed, the same job is claimable.
    expect(
      await claimJobs('worker-a', 5, new Date(Date.now() + 2 * 60 * 60 * 1000)),
    ).toHaveLength(1)
  })

  it('drops a duplicate enqueue rather than stacking it', async () => {
    const fixture = await createCompanyFixture()

    const first = await enqueue({
      kind: 'test.probe',
      companyId: fixture.companyId,
      dedupeKey: 'nightly:2026-08-13',
    })
    const second = await enqueue({
      kind: 'test.probe',
      companyId: fixture.companyId,
      dedupeKey: 'nightly:2026-08-13',
    })

    expect(first.enqueued).toBe(true)
    expect(second.enqueued).toBe(false)
    expect(second.id).toBeNull()

    const jobs = await listJobs({ companyId: fixture.companyId })
    expect(jobs).toHaveLength(1)
  })

  it('backs a failed job off rather than retrying it immediately', async () => {
    const fixture = await createCompanyFixture()
    await enqueue({ kind: 'test.probe', companyId: fixture.companyId })

    const [job] = await claimJobs('worker-a')
    const outcome = await failJob(job, new Error('provider down'), new Date(), () => 0)

    expect(outcome.willRetry).toBe(true)
    // A failed job that stayed immediately claimable would spin through its
    // five attempts in one tick and dead-letter a transient outage.
    expect(await claimJobs('worker-a')).toHaveLength(0)
  })

  it('dead-letters a job that runs out of attempts', async () => {
    const fixture = await createCompanyFixture()
    await enqueue({ kind: 'test.probe', companyId: fixture.companyId, maxAttempts: 2 })

    for (let round = 0; round < 2; round++) {
      const [job] = await claimJobs('worker-a', 5, new Date(Date.now() + round * 60 * 60 * 1000))
      await failJob(job, new Error('still broken'))
    }

    const counts = await queueCounts(fixture.companyId)
    expect(counts.dead).toBe(1)

    // Dead means dead: it is not picked up again on its own.
    expect(await claimJobs('worker-a', 5, new Date(Date.now() + 86_400_000))).toHaveLength(0)
  })

  it('reports every state, including the empty ones', async () => {
    const fixture = await createCompanyFixture()
    const counts = await queueCounts(fixture.companyId)

    // A dashboard reading `counts.dead` and getting undefined renders
    // "NaN dead" — a bug this codebase has shipped once already.
    for (const state of ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled']) {
      expect(counts[state]).toBe(0)
    }
  })

  it('steals a claim from a worker that died holding it', async () => {
    const fixture = await createCompanyFixture()
    await enqueue({ kind: 'test.probe', companyId: fixture.companyId })

    const claimed = await claimJobs('worker-that-dies')
    expect(claimed).toHaveLength(1)

    // Still held, so nobody else takes it.
    expect(await claimJobs('worker-b')).toHaveLength(0)

    // Past the timeout, it is fair game. This is a deliberate second
    // execution, and the only reason it is acceptable is that handlers
    // tolerate it.
    const later = new Date(Date.now() + CLAIM_TIMEOUT_MS + 1_000)
    expect(await claimJobs('worker-b', 5, later)).toHaveLength(1)
  })

  it('runs higher priority first', async () => {
    const fixture = await createCompanyFixture()

    await enqueue({ kind: 'test.probe', companyId: fixture.companyId, payload: { tag: 'low' } })
    await enqueue({
      kind: 'test.probe',
      companyId: fixture.companyId,
      payload: { tag: 'high' },
      priority: 10,
    })

    const [first] = await claimJobs('worker-a', 1)
    expect(first.payload.tag).toBe('high')
  })

  it('resets attempts when a person retries a dead job', async () => {
    const fixture = await createCompanyFixture()
    await enqueue({ kind: 'test.probe', companyId: fixture.companyId, maxAttempts: 1 })

    const [job] = await claimJobs('worker-a')
    await failJob(job, new Error('broken'))

    await retryJob(job.id)

    const [again] = await claimJobs('worker-a')
    // Somebody pressing retry has usually just fixed the cause. Carrying the
    // old count would give it one grudging attempt before dying again.
    expect(again.attempts).toBe(1)
  })

  it('cancels a queued job without running it', async () => {
    const fixture = await createCompanyFixture()
    const { id } = await enqueue({ kind: 'test.probe', companyId: fixture.companyId })

    await cancelJob(id!)

    expect(await claimJobs('worker-a')).toHaveLength(0)
    expect((await queueCounts(fixture.companyId)).cancelled).toBe(1)
  })

  it('never prunes a dead job', async () => {
    const fixture = await createCompanyFixture()

    const done = await enqueue({ kind: 'test.probe', companyId: fixture.companyId })
    await completeJob(done.id!, {}, new Date('2020-01-01T00:00:00Z'))

    await enqueue({
      kind: 'test.probe',
      companyId: fixture.companyId,
      dedupeKey: 'dead-one',
      maxAttempts: 1,
    })
    const [job] = await claimJobs('worker-a')
    await failJob(job, new Error('broken'), new Date('2020-01-01T00:00:00Z'))

    const deleted = await pruneFinishedJobs(new Date('2021-01-01T00:00:00Z'))

    expect(deleted).toBe(1)
    // A failure nobody looked at is not evidence to be tidied away — the
    // alternative is discovering it by its consequences.
    expect((await queueCounts(fixture.companyId)).dead).toBe(1)
  })
})

describe('the runner', () => {
  it('runs a job and records what it returned', async () => {
    const fixture = await createCompanyFixture()
    probeRuns = 0
    probeShouldThrow = false

    await enqueue({ kind: 'test.probe', companyId: fixture.companyId })

    const tick = await runOnce({ workerId: 'test-runner' })

    expect(tick.jobsRun).toBe(1)
    expect(tick.jobsSucceeded).toBe(1)
    expect(probeRuns).toBe(1)

    const [row] = await listJobs({ companyId: fixture.companyId })
    expect(row.status).toBe('succeeded')
    expect(row.result).toMatchObject({ company: fixture.companyId })
  })

  it('fails one job without stopping the others in the batch', async () => {
    const fixture = await createCompanyFixture()
    probeRuns = 0

    await enqueue({ kind: 'test.probe', companyId: fixture.companyId, dedupeKey: 'ok-1' })
    await enqueue({ kind: 'does.not.exist', companyId: fixture.companyId, dedupeKey: 'bad-1' })
    await enqueue({ kind: 'test.probe', companyId: fixture.companyId, dedupeKey: 'ok-2' })

    probeShouldThrow = false
    const tick = await runOnce({ workerId: 'test-runner' })

    expect(tick.jobsRun).toBe(3)
    expect(tick.jobsSucceeded).toBe(2)
    // One broken job kind must not stop every other kind from running.
    expect(probeRuns).toBe(2)
  })

  it('dead-letters an unknown kind immediately instead of retrying it', async () => {
    const fixture = await createCompanyFixture()

    await enqueue({ kind: 'removed.by.a.deploy', companyId: fixture.companyId })

    const tick = await runOnce({ workerId: 'test-runner' })

    expect(tick.jobsDead).toBe(1)
    // Retrying cannot conjure a handler back. Burning five attempts and an
    // hour of backoff to rediscover that hides the real problem behind a
    // "retrying" status.
    const [row] = await listJobs({ companyId: fixture.companyId })
    expect(row.status).toBe('dead')
    expect(row.lastError).toMatch(/No handler registered/i)
  })

  it('refuses a tenant job that arrives with no company', async () => {
    await enqueue({ kind: 'test.probe', companyId: null, dedupeKey: 'tenantless' })

    await runOnce({ workerId: 'test-runner' })

    const [row] = await listJobs({ kind: 'test.probe' })
    expect(row.lastError).toMatch(/needs a company/i)
  })

  it('gives a global handler no actor at all', async () => {
    await enqueue({ kind: 'test.global_probe', companyId: null })

    await runOnce({ workerId: 'test-runner' })

    const [row] = await listJobs({ kind: 'test.global_probe' })
    // Not an actor for some arbitrary company. The type makes a handler that
    // wants tenant data deal with the null rather than assume.
    expect(row.result).toMatchObject({ hadActor: false })
  })

  it('reports whether a worker is alive', async () => {
    await runOnce({ workerId: 'heartbeat-probe' })

    const statuses = await workerStatuses()
    const probe = statuses.find((entry) => entry.workerId === 'heartbeat-probe')!

    expect(probe.isAlive).toBe(true)

    // "The queue is empty" and "nothing is draining the queue" look identical
    // without this, and the second one is an outage.
    const later = new Date(Date.now() + HEARTBEAT_STALE_MS + 1_000)
    const stale = (await workerStatuses(later)).find((e) => e.workerId === 'heartbeat-probe')!
    expect(stale.isAlive).toBe(false)
  })
})

describe('scheduling', () => {
  it('always returns a time strictly after the one given', () => {
    // A next-run equal to now gives a scheduler that fires the same job
    // forever, because every tick computes a time that has already passed.
    const moments = [
      new Date('2026-08-13T00:00:00Z'),
      new Date('2026-08-13T09:00:00Z'),
      new Date('2026-08-13T23:59:59Z'),
      new Date('2026-02-28T09:00:00Z'),
      new Date('2026-12-31T23:00:00Z'),
    ]

    for (const cadence of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      for (const now of moments) {
        const next = nextRunAt({ cadence, hourUtc: 9, dayOfWeek: 1, dayOfMonth: 1 }, now)
        expect(next.getTime()).toBeGreaterThan(now.getTime())
      }
    }
  })

  it('lands on the hour asked for', () => {
    const next = nextRunAt({ cadence: 'daily', hourUtc: 6 }, new Date('2026-08-13T09:00:00Z'))

    expect(next.toISOString()).toBe('2026-08-14T06:00:00.000Z')
  })

  it('lands on the weekday asked for', () => {
    // 2026-08-13 is a Thursday; the next Monday is the 17th.
    const next = nextRunAt(
      { cadence: 'weekly', hourUtc: 7, dayOfWeek: 1 },
      new Date('2026-08-13T09:00:00Z'),
    )

    expect(next.toISOString()).toBe('2026-08-17T07:00:00.000Z')
  })

  it('does not skip a month when rolling over from a long one', () => {
    // Setting the date before the month is the bug this guards: the 31st of
    // January plus one month is the 31st of February, which Postgres and
    // JavaScript both resolve to March.
    const next = nextRunAt(
      { cadence: 'monthly', hourUtc: 3, dayOfMonth: 1 },
      new Date('2026-01-31T09:00:00Z'),
    )

    expect(next.toISOString()).toBe('2026-02-01T03:00:00.000Z')
  })

  it('turns a due schedule into exactly one job and advances it', async () => {
    const fixture = await createCompanyFixture()

    const schedule = await upsertSchedule({
      kind: 'test.probe',
      companyId: fixture.companyId,
      cadence: 'daily',
      hourUtc: 3,
      startAt: new Date('2026-08-13T02:00:00Z'),
    })

    const firstDue = schedule.nextRunAt
    const justAfter = new Date(firstDue.getTime() + 1_000)

    const first = await runDueSchedules(justAfter)
    expect(first.fired).toBe(1)

    // Ticking again immediately must not fire it a second time — the schedule
    // advanced, so it is no longer due.
    const second = await runDueSchedules(justAfter)
    expect(second.fired).toBe(0)

    const jobs = await listJobs({ companyId: fixture.companyId, kind: 'test.probe' })
    expect(jobs).toHaveLength(1)
  })

  it('upserts rather than creating a second schedule of the same kind', async () => {
    const fixture = await createCompanyFixture()

    await upsertSchedule({ kind: 'test.probe', companyId: fixture.companyId, cadence: 'daily' })
    await upsertSchedule({
      kind: 'test.probe',
      companyId: fixture.companyId,
      cadence: 'weekly',
      hourUtc: 5,
    })

    const { listSchedules } = await import('@/modules/worker/schedules')
    const schedules = (await listSchedules(fixture.companyId)).filter(
      (s) => s.kind === 'test.probe',
    )

    // Two "daily review nudge" schedules means the nudge goes out twice.
    expect(schedules).toHaveLength(1)
    expect(schedules[0].cadence).toBe('weekly')
  })
})

describe('the outbox', () => {
  it('keeps the event and the change in one transaction', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      db.transaction(async (tx) => {
        await recordEvent(
          { companyId: fixture.companyId, userId: fixture.userId },
          { type: 'invoice.paid', entityType: 'invoice', entityId: fixture.companyId },
          tx,
        )
        throw new Error('the change failed after the event was written')
      }),
    ).rejects.toThrow(/the change failed/)

    // If the change rolls back, so does the event. An event claiming something
    // happened when it did not is worse than a lost notification.
    expect(await pendingEventCount(fixture.companyId)).toBe(0)
  })

  it('turns an event into a job and marks it relayed', async () => {
    const fixture = await createCompanyFixture()

    await recordEvent(
      { companyId: fixture.companyId, userId: fixture.userId },
      {
        type: 'proposal.accepted',
        entityType: 'proposal',
        payload: { proposalNumber: 'PRO-1001', clientName: 'Harborview', won: true },
      },
    )

    expect(await pendingEventCount(fixture.companyId)).toBe(1)

    const relayed = await relayPendingEvents()
    expect(relayed.relayed).toBe(1)
    expect(relayed.jobsQueued).toBe(1)
    expect(await pendingEventCount(fixture.companyId)).toBe(0)

    const jobs = await listJobs({ companyId: fixture.companyId, kind: 'notify.proposal_decided' })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].payload).toMatchObject({ proposalNumber: 'PRO-1001' })
  })

  it('relaying twice does not send twice', async () => {
    const fixture = await createCompanyFixture()

    const event = await recordEvent(
      { companyId: fixture.companyId, userId: fixture.userId },
      { type: 'proposal.accepted', payload: { proposalNumber: 'PRO-1002' } },
    )

    await relayPendingEvents()

    // A worker killed between enqueueing and marking relayed leaves the event
    // pending, and the next pass relays it again.
    await db.update(domainEvents).set({ relayedAt: null }).where(eq(domainEvents.id, event.id))
    await relayPendingEvents()

    const jobs = await listJobs({ companyId: fixture.companyId, kind: 'notify.proposal_decided' })
    expect(jobs).toHaveLength(1)
  })

  it('records an event when an invoice is settled, and not when it is part-paid', async () => {
    const fixture = await createCompanyFixture()
    const { createCustomer, createInvoice, recordPayment } = await import(
      '@/modules/receivables/service'
    )
    const revenue = await fixture.account('4100')

    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-03-10',
      amountCents: 40_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 40_000 }],
    })

    // "They paid some of it" is a balance, not news.
    expect(await pendingEventCount(fixture.companyId)).toBe(0)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-03-20',
      amountCents: 60_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 60_000 }],
    })

    const events = await db
      .select()
      .from(domainEvents)
      .where(
        and(eq(domainEvents.companyId, fixture.companyId), eq(domainEvents.type, 'invoice.paid')),
      )

    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ customerName: 'Harborview LLC' })
  })

  it('marks an event with no subscribers relayed rather than leaving it pending', async () => {
    const fixture = await createCompanyFixture()

    await recordEvent(
      { companyId: fixture.companyId, userId: fixture.userId },
      { type: 'payroll.posted', payload: { reference: 'PR-1001' } },
    )

    await relayPendingEvents()

    // Not useless: a durable record of something that happened, and a
    // subscriber added later is a code change rather than a backfill.
    expect(await pendingEventCount(fixture.companyId)).toBe(0)
  })

  it('records an event when a proposal is accepted, inside the acceptance', async () => {
    const fixture = await createCompanyFixture()

    const { createOpportunity, createOrganization } = await import('@/modules/crm/opportunities')
    const { createProposal, sendProposal } = await import('@/modules/crm/proposals')
    const { acceptProposal } = await import('@/modules/crm/acceptance')

    const organization = await createOrganization(fixture.ctx, { name: 'Harborview' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Foundation package',
      expectedValueCents: 500_000,
    })
    const revenue = await fixture.account('4000')

    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Foundation proposal',
      items: [
        { description: 'Excavation', unitPriceCents: 500_000, chartAccountId: revenue.id },
      ],
    })
    await sendProposal(fixture.ctx, proposal.id)

    const accepted = await acceptProposal(proposal.publicToken, {
      signerName: 'Jo Rivera',
      signerEmail: 'jo@harborview.test',
      signatureText: 'Jo Rivera',
      selectedItemIds: [],
      agreed: true,
    })
    expect(accepted.ok).toBe(true)

    const events = await db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.companyId, fixture.companyId),
          eq(domainEvents.type, 'proposal.accepted'),
        ),
      )

    // The swallowed `.catch(() => {})` this replaces left no trace at all.
    expect(events).toHaveLength(1)
    expect(events[0].relayedAt).toBeNull()
    expect(events[0].actorId).toBeNull()
  })
})

describe('who a scheduled task is', () => {
  it('cannot sign in', async () => {
    const fixture = await createCompanyFixture()
    await systemActor(fixture.companyId)

    const [row] = await db.select().from(users).where(eq(users.email, SYSTEM_USER_EMAIL)).limit(1)
    expect(row).toBeDefined()

    // The stored value is not a scrypt hash and cannot become one:
    // `verifyPassword` splits on `$` and bails unless it finds six parts.
    // "Cannot sign in" is a claim that has to be checked rather than believed.
    for (const attempt of ['', 'password', 'system-actor-no-password', row.passwordHash]) {
      expect(await verifyPassword(attempt, row.passwordHash)).toBe(false)
    }
  })

  it('is a member of no company', async () => {
    const fixture = await createCompanyFixture()
    const actor = await systemActor(fixture.companyId)

    const { memberships } = await import('@/db/schema')
    const rows = await db.select().from(memberships).where(eq(memberships.userId, actor.userId))

    // Even a session minted for this id resolves to nothing, because
    // `resolveSession` reads the membership.
    expect(rows).toHaveLength(0)
  })

  it('is created once however many workers ask for it', async () => {
    const first = await createCompanyFixture()
    const second = await createCompanyFixture()

    const actors = await Promise.all([
      systemActor(first.companyId),
      systemActor(second.companyId),
      systemActor(first.companyId),
    ])

    expect(new Set(actors.map((a) => a.userId)).size).toBe(1)
    expect(actors.every((a) => isSystemActor(a))).toBe(true)
    expect(actors[0].userName).toBe(SYSTEM_USER_NAME)
  })

  it('shows as itself in the audit trail, not as a person', async () => {
    const fixture = await createCompanyFixture()
    const actor = await systemActor(fixture.companyId)
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')

    await draftJournalEntry(actor, {
      entryDate: '2026-08-31',
      memo: 'Proposed by a scheduled task',
      lines: [
        { chartAccountId: cash.id, debitCents: 10_000 },
        { chartAccountId: revenue.id, creditCents: 10_000 },
      ],
    })

    const { recentActivity } = await import('@/modules/audit')
    const events = await recentActivity(fixture.ctx, 20)
    const drafted = events.find((event) => event.action === 'journal.draft')!

    // An owner who did not post that entry must not find their name on it.
    expect(drafted.actorName).toBe(SYSTEM_USER_NAME)
  })
})

describe('what a background job is not allowed to decide', () => {
  it('proposes the WIP entry as a draft that changes no figure', async () => {
    const fixture = await createCompanyFixture({ industry: 'construction' })
    const actor = await systemActor(fixture.companyId)
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4200')

    const before = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })

    const entry = await draftJournalEntry(actor, {
      entryDate: '2026-08-31',
      memo: 'WIP adjustment — proposed, not posted.',
      sourceType: 'wip_adjustment',
      lines: [
        { chartAccountId: cash.id, debitCents: 250_000 },
        { chartAccountId: revenue.id, creditCents: 250_000 },
      ],
    })

    const after = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })

    // ADR 0007 refused to post this automatically, and having a worker did not
    // change that judgement. The work is done; the decision is not taken.
    expect(after.totalDebitCents).toBe(before.totalDebitCents)
    expect(after.isBalanced).toBe(true)

    const drafts = await listDraftEntries(fixture.ctx)
    expect(drafts.map((d) => d.id)).toContain(entry.id)
  })

  it('affects the books only once a person posts it', async () => {
    const fixture = await createCompanyFixture()
    const actor = await systemActor(fixture.companyId)
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')

    const entry = await draftJournalEntry(actor, {
      entryDate: '2026-08-31',
      memo: 'Proposed',
      lines: [
        { chartAccountId: cash.id, debitCents: 90_000 },
        { chartAccountId: revenue.id, creditCents: 90_000 },
      ],
    })

    await postDraftEntry(fixture.ctx, entry.id)

    const after = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(after.totalDebitCents).toBe(90_000)

    const [row] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, entry.id))
      .limit(1)

    expect(row.status).toBe('posted')
    // Posted by the person who decided, not by the task that proposed it.
    expect(row.postedBy).toBe(fixture.userId)
  })

  it('refuses to post a draft twice', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')

    const entry = await draftJournalEntry(fixture.ctx, {
      entryDate: '2026-08-31',
      memo: 'Proposed',
      lines: [
        { chartAccountId: cash.id, debitCents: 5_000 },
        { chartAccountId: revenue.id, creditCents: 5_000 },
      ],
    })

    await postDraftEntry(fixture.ctx, entry.id)
    await expect(postDraftEntry(fixture.ctx, entry.id)).rejects.toThrow(/is posted, not a draft/i)
  })

  it('will not delete a posted entry through the draft path', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')

    const entry = await draftJournalEntry(fixture.ctx, {
      entryDate: '2026-08-31',
      memo: 'Proposed',
      lines: [
        { chartAccountId: cash.id, debitCents: 5_000 },
        { chartAccountId: revenue.id, creditCents: 5_000 },
      ],
    })

    await postDraftEntry(fixture.ctx, entry.id)

    await expect(discardDraftEntry(fixture.ctx, entry.id)).rejects.toThrow(
      /voided, never deleted/i,
    )
  })

  it('discards a proposal nobody wanted', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')

    const entry = await draftJournalEntry(fixture.ctx, {
      entryDate: '2026-08-31',
      memo: 'Proposed',
      lines: [
        { chartAccountId: cash.id, debitCents: 5_000 },
        { chartAccountId: revenue.id, creditCents: 5_000 },
      ],
    })

    await discardDraftEntry(fixture.ctx, entry.id)

    expect(await listDraftEntries(fixture.ctx)).toHaveLength(0)
    const after = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(after.totalDebitCents).toBe(0)
  })
})

describe('handlers', () => {
  it('registers every kind the queue can be asked for', () => {
    const kinds = registeredKinds().map((entry) => entry.kind)

    // The four ADRs' worth of blocked features, now with something calling
    // them: 0005's campaign scheduler, 0007's WIP entry, 0008's nudge and key
    // pruning, 0009's remittance reminder.
    expect(kinds).toContain('campaign.send_due')
    expect(kinds).toContain('jobs.propose_wip_entry')
    expect(kinds).toContain('mobile.nudge_review')
    expect(kinds).toContain('housekeeping.prune_idempotency_keys')
    expect(kinds).toContain('payroll.remittance_due')
    expect(kinds).toContain('bank.sync_all')

    for (const entry of registeredKinds()) {
      expect(entry.label.length).toBeGreaterThan(0)
    }
  })

  it('names what is registered when asked for something that is not', () => {
    expect(getHandler('nothing.like.this')).toBeUndefined()
  })

  it('skips the WIP proposal for a company without job costing', async () => {
    const fixture = await createCompanyFixture({ industry: 'retail' })

    await enqueue({
      kind: 'jobs.propose_wip_entry',
      companyId: fixture.companyId,
      payload: { asOfDate: '2026-08-31' },
    })

    await runOnce({ workerId: 'test-runner' })

    const [row] = await listJobs({ companyId: fixture.companyId, kind: 'jobs.propose_wip_entry' })
    expect(row.status).toBe('succeeded')
    expect(row.result).toMatchObject({ skipped: expect.stringMatching(/not switched on/i) })
  })

  it('proposes the WIP entry for a month that has ended, not for today', async () => {
    const fixture = await createCompanyFixture({ industry: 'construction' })

    // A job with cost on it and nothing billed, so there is an underbilling to
    // adjust and the handler has something to propose.
    const { projects } = await import('@/db/schema')
    const { setJobBudget } = await import('@/modules/jobs/budgets')
    const { postManualEntry } = await import('@/modules/ledger/journal')
    const { installDefaultCostCodes, listCostCodes } = await import('@/modules/jobs/cost-codes')

    const [job] = await db
      .insert(projects)
      .values({
        companyId: fixture.companyId,
        code: 'JOB-1001',
        name: 'Harborview Renovation',
        contractValueCents: 1_000_000,
        startDate: '2026-01-05',
      })
      .returning()

    await installDefaultCostCodes(fixture.ctx)
    const [code] = await listCostCodes(fixture.ctx)
    await setJobBudget(fixture.ctx, job.id, [
      { costCodeId: code.id, originalAmountCents: 800_000 },
    ])

    const cash = await fixture.account('1000')
    const labor = await fixture.account('5120')
    const lastMonthEnd = previousMonthEndIso()

    await postManualEntry(fixture.ctx, {
      entryDate: lastMonthEnd,
      memo: 'Job labour',
      lines: [
        {
          chartAccountId: labor.id,
          debitCents: 400_000,
          projectId: job.id,
          costCodeId: code.id,
        },
        { chartAccountId: cash.id, creditCents: 400_000 },
      ],
    })

    // No asOfDate given, so the handler picks one.
    await enqueue({ kind: 'jobs.propose_wip_entry', companyId: fixture.companyId })
    await runOnce({ workerId: 'test-runner' })

    const [row] = await listJobs({ companyId: fixture.companyId, kind: 'jobs.propose_wip_entry' })
    expect(row.status).toBe('succeeded')
    expect(row.result).toMatchObject({ proposed: true })

    const [draft] = await listDraftEntries(fixture.ctx)
    // A period-end adjustment for a period that has not ended is an adjustment
    // against half a month of cost — wrong on the day it is proposed.
    expect(draft.entryDate).toBe(lastMonthEnd)
    expect(draft.entryDate < new Date().toISOString().slice(0, 10)).toBe(true)
  })

  it('stays quiet when no agency is owed anything', async () => {
    const fixture = await createCompanyFixture()

    await enqueue({
      kind: 'payroll.remittance_due',
      companyId: fixture.companyId,
      payload: { asOfDate: '2026-08-31' },
    })

    await runOnce({ workerId: 'test-runner' })

    const [row] = await listJobs({ companyId: fixture.companyId, kind: 'payroll.remittance_due' })
    // A reminder that is always on is a reminder nobody reads.
    expect(row.result).toMatchObject({ skipped: expect.stringMatching(/nothing owed/i) })
  })
})

describe('tenant isolation', () => {
  it('does not show one company another company\'s jobs', async () => {
    const first = await createCompanyFixture()
    const second = await createCompanyFixture()

    await enqueue({ kind: 'test.probe', companyId: first.companyId, dedupeKey: 'first' })
    await enqueue({ kind: 'test.probe', companyId: second.companyId, dedupeKey: 'second' })

    const firstJobs = await listJobs({ companyId: first.companyId })
    expect(firstJobs).toHaveLength(1)
    expect(firstJobs[0].companyId).toBe(first.companyId)
  })

  it('shows housekeeping jobs to everybody rather than nobody', async () => {
    const fixture = await createCompanyFixture()

    await enqueue({ kind: 'housekeeping.prune_jobs', companyId: null })

    const jobs = await listJobs({ companyId: fixture.companyId })
    // A global job hidden from every company is a global job nobody ever sees
    // fail.
    expect(jobs.some((job) => job.kind === 'housekeeping.prune_jobs')).toBe(true)
  })

  it('gives a handler an actor scoped to its own company', async () => {
    const first = await createCompanyFixture()
    const second = await createCompanyFixture()

    await enqueue({ kind: 'test.probe', companyId: second.companyId, dedupeKey: 'scoped' })
    await runOnce({ workerId: 'test-runner' })

    const [row] = await listJobs({ companyId: second.companyId, kind: 'test.probe' })
    expect(row.result).toMatchObject({ company: second.companyId })
    expect(row.result).not.toMatchObject({ company: first.companyId })
  })
})

/** The last day of the month before this one, UTC — mirrors the handler. */
function previousMonthEndIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10)
}
