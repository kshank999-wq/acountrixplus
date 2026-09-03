import { describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  actionTokens,
  backgroundJobs,
  campaignEvents,
  campaignRecipients,
  campaigns,
  documentBlobs,
  domainEvents,
  guardAttempts,
  journalLines,
  leadSubmissions,
  loginAttempts,
  proposalViews,
  sendingSnapshots,
  sessions,
  transactionalMessages,
} from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import {
  NEVER_SWEPT,
  RETENTION_POLICIES,
  cutoffFor,
  policyFor,
  retentionSummary,
} from '@/modules/retention/policy'
import { retentionReport, sweepAll, sweepOne } from '@/modules/retention/sweep'
import type { Audience } from '@/modules/retention/attribution'
import { health } from '@/modules/worker/health'
import { recordLoginAttempt } from '@/modules/auth/login-history'
import { issueToken } from '@/modules/notify/tokens'
import { createTask, openWork } from '@/modules/engagement/tasks'
import { COMPANY_SCHEDULES, GLOBAL_SCHEDULES } from '@/modules/worker/defaults'
import { getHandler, registeredKinds } from '@/modules/worker/registry'
import '@/modules/worker/handlers'

/**
 * Retention, and the work nobody was doing (spec §19, §18, Phase 24).
 *
 * Three claims:
 *
 *  1. **Nothing grows without bound, and retention never touches the books.**
 *     Every table that grows with traffic has a named policy; the policy list
 *     is an allowlist, and the ledger, the audit log and the evidence store
 *     are not on it.
 *  2. **A promise is chased without somebody opening a page.** The overdue
 *     follow-up chase and the rent run are handlers with schedules, not
 *     buttons.
 *  3. **A failure is never silent** — and never noisy either: a digest with a
 *     count, and nothing at all on a quiet day.
 */

/** Nobody's company: the only viewer for whom a total is a true answer. */
const DEPLOYMENT: Audience = { kind: 'deployment' }

describe('the retention policy', () => {
  it('never names a table that holds the books', () => {
    const swept = new Set(RETENTION_POLICIES.map((policy) => policy.table))

    // The safety property, asserted by name. Adding a policy for
    // `journal_lines` fails here rather than at the year-end.
    for (const table of NEVER_SWEPT) {
      expect(swept.has(table)).toBe(false)
    }
  })

  it('says how long it keeps everything, and why', () => {
    const summary = retentionSummary()
    expect(summary.length).toBe(RETENTION_POLICIES.length)

    for (const policy of summary) {
      // A policy nobody can explain is a policy nobody can defend to somebody
      // asking what is held about them.
      expect(policy.why.length).toBeGreaterThan(40)
      expect(policy.label.length).toBeGreaterThan(0)
      if (policy.days !== null) expect(policy.days).toBeGreaterThan(0)
    }
  })

  it('names each policy exactly once, and each table exactly once', () => {
    const kinds = RETENTION_POLICIES.map((policy) => policy.kind)
    const tables = RETENTION_POLICIES.map((policy) => policy.table)

    expect(new Set(kinds).size).toBe(kinds.length)
    // Two policies on one table would mean two answers to "how long do you
    // keep this", and the shorter one would silently win.
    expect(new Set(tables).size).toBe(tables.length)
  })

  it('measures the cutoff from a date it is given, not from the clock', () => {
    const asOf = new Date('2026-06-15T00:00:00Z')
    const policy = policyFor('login_attempts')

    const cutoff = cutoffFor(policy, asOf)
    expect(cutoff?.toISOString().slice(0, 10)).toBe('2026-03-17')

    // The orphan sweep asks about reachability, not age.
    expect(cutoffFor(policyFor('orphaned_blobs'), asOf)).toBeNull()
  })

  it('refuses to describe a policy that does not exist', () => {
    expect(() => policyFor('nonsense' as never)).toThrow(/No retention policy/)
  })

  /**
   * The tripwire (Phase 101).
   *
   * `RETENTION_POLICIES` opened with a claim to name every table that grows
   * with traffic. It named ten, and `guard_attempts` — added by the phase
   * immediately before — was not among them. Nothing here noticed, because the
   * only assertion about the two lists was that they did not overlap.
   *
   * The catalogue cannot close that gap the way Phase 96's `pg_constraint`
   * check closes the merge registry's: *what points at `customers`* is a fact
   * the database holds, and *grows with traffic* is not. `documents` and
   * `domain_events` are indistinguishable to the catalogue and belong on
   * opposite sides of this list.
   *
   * So the crude one, which works: the number is written down, and adding a
   * table fails here. Yes, that means a one-line edit on every migration. That
   * is the price of the moment where somebody decides.
   */
  const TABLE_COUNT = 178

  const HOW_TO_ANSWER = [
    'The number of tables changed, so a table was added or dropped.',
    'Decide which this new one is and then update TABLE_COUNT:',
    '  - it grows with traffic  -> give it a policy in RETENTION_POLICIES',
    '  - it is the business, or evidence -> add it to NEVER_SWEPT',
    'Neither is a formality: guard_attempts spent a phase in the gap.',
  ].join('\n')

  it('makes a new table answer whether it needs a retention policy', async () => {
    const rows = (await db.execute(
      sql`select count(*)::int as n
          from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    )) as unknown as Array<{ n: number }>

    expect(Number(rows[0].n), HOW_TO_ANSWER).toBe(TABLE_COUNT)
  })

  it('sweeps the table the phase before this one added', async () => {
    // The specific miss that produced the tripwire above, asserted by name so
    // that deleting the policy is loud rather than quiet.
    const policy = policyFor('guard_attempts')

    expect(policy.table).toBe('guard_attempts')
    // Longer than the sign-in record deliberately: `login_attempts` is short
    // because strangers write it at a rate they choose, not because it matters
    // less. Reaching a guarded act needs a live session.
    expect(policy.days).toBe(365)
    expect(policyFor('login_attempts').days).toBeLessThan(policy.days!)
    expect(policy.publicallyWritten).toBe(false)
  })

  it('has one answer to how long an expired token is kept', async () => {
    // `tokens.ts` used to carry its own `pruneExpiredTokens(30)` with no
    // production caller, duplicating this policy's thirty days. A reader who
    // changed the number there would have changed nothing (Phase 101).
    const tokens = await import('@/modules/notify/tokens')

    expect('pruneExpiredTokens' in tokens).toBe(false)
    expect(policyFor('action_tokens').days).toBe(30)
  })
})

describe('sweeping', () => {
  it('deletes sign-in attempts past the window and keeps the recent ones', async () => {
    await recordLoginAttempt({ email: 'old@example.test', outcome: 'wrong_password' })
    await recordLoginAttempt({ email: 'recent@example.test', outcome: 'wrong_password' })

    // The old one, backdated past ninety days.
    await db
      .update(loginAttempts)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(loginAttempts.email, 'old@example.test'))

    // The deployment audience: sign-in attempts have no company, so this is
    // the only viewer they are counted for at all (Phase 102).
    const before = await retentionReport(DEPLOYMENT, new Date('2026-06-15T00:00:00Z'))
    const attempts = before.find((row) => row.kind === 'login_attempts')!
    expect(attempts.counted && attempts.held).toBe(2)
    expect(attempts.counted && attempts.expired).toBe(1)

    const result = await sweepOne('login_attempts', new Date('2026-06-15T00:00:00Z'))
    expect(result.removed).toBe(1)

    const left = await db.select({ email: loginAttempts.email }).from(loginAttempts)
    expect(left.map((row) => row.email)).toEqual(['recent@example.test'])
  })

  it('runs twice and deletes once', async () => {
    await recordLoginAttempt({ email: 'old@example.test', outcome: 'wrong_password' })
    await db
      .update(loginAttempts)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(loginAttempts.email, 'old@example.test'))

    const asOf = new Date('2026-06-15T00:00:00Z')
    expect((await sweepOne('login_attempts', asOf)).removed).toBe(1)
    // Idempotent by construction — it is a ranged delete, so the second run
    // finds nothing rather than needing to know the first happened.
    expect((await sweepOne('login_attempts', asOf)).removed).toBe(0)
  })

  it('keeps a token until well past its expiry', async () => {
    const fixture = await createCompanyFixture({ name: 'Token Co' })

    const issued = await issueToken({
      purpose: 'company_invitation',
      email: 'invitee@example.test',
      companyId: fixture.companyId,
      role: 'bookkeeper',
      invitedBy: fixture.userId,
    })

    // Expired yesterday: still held, because the policy measures thirty days
    // *past expiry*, not thirty days past issue.
    await db
      .update(actionTokens)
      .set({ expiresAt: new Date('2026-06-14T00:00:00Z') })
      .where(eq(actionTokens.id, issued.id))

    const asOf = new Date('2026-06-15T00:00:00Z')
    expect((await sweepOne('action_tokens', asOf)).removed).toBe(0)

    await db
      .update(actionTokens)
      .set({ expiresAt: new Date('2026-04-01T00:00:00Z') })
      .where(eq(actionTokens.id, issued.id))

    expect((await sweepOne('action_tokens', asOf)).removed).toBe(1)
  })

  it('never sweeps an event that has not been relayed', async () => {
    const fixture = await createCompanyFixture({ name: 'Outbox Co' })
    const old = new Date('2020-01-01T00:00:00Z')

    const [waiting] = await db
      .insert(domainEvents)
      .values({
        companyId: fixture.companyId,
        type: 'invoice.paid',
        payload: {},
        occurredAt: old,
      })
      .returning({ id: domainEvents.id })

    await db.insert(domainEvents).values({
      companyId: fixture.companyId,
      type: 'invoice.paid',
      payload: {},
      occurredAt: old,
      relayedAt: old,
    })

    const removed = await sweepOne('domain_events', new Date('2026-06-15T00:00:00Z'))

    // An outbox that deletes work in progress is not an outbox.
    expect(removed.removed).toBe(1)
    const left = await db.select({ id: domainEvents.id }).from(domainEvents)
    expect(left.map((row) => row.id)).toEqual([waiting.id])
  })

  it('never sweeps a lead that became an opportunity', async () => {
    const fixture = await createCompanyFixture({ name: 'Intake Co' })
    const old = new Date('2020-01-01T00:00:00Z')

    const [converted] = await db
      .insert(leadSubmissions)
      .values({
        companyId: fixture.companyId,
        accepted: true,
        receivedAt: old,
        createdOpportunityId: '00000000-0000-0000-0000-000000000001',
      })
      .returning({ id: leadSubmissions.id })

    await db.insert(leadSubmissions).values({
      companyId: fixture.companyId,
      accepted: false,
      receivedAt: old,
      rejectionReason: 'honeypot',
    })

    const removed = await sweepOne('lead_submissions', new Date('2026-06-15T00:00:00Z'))

    // The honeypot catch goes; the one somebody is still working stays,
    // however old the row is.
    expect(removed.removed).toBe(1)
    const left = await db.select({ id: leadSubmissions.id }).from(leadSubmissions)
    expect(left.map((row) => row.id)).toEqual([converted.id])
  })

  it('leaves the ledger exactly where it was', async () => {
    const fixture = await createCompanyFixture({ name: 'Books Co' })
    const { postManualEntry } = await import('@/modules/ledger/journal')
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2019-01-01',
      memo: 'Older than every retention window in the policy',
      lines: [
        { chartAccountId: cash.id, debitCents: 100_000 },
        { chartAccountId: revenue.id, creditCents: 100_000 },
      ],
    })

    const before = await db
      .select({ n: sql<string>`count(*)` })
      .from(journalLines)
      .where(eq(journalLines.companyId, fixture.companyId))

    // Every policy, run against a date long after that entry. Nothing in this
    // module can reach it — the allowlist is the mechanism, and this is the
    // demonstration.
    await sweepAll(new Date('2030-01-01T00:00:00Z'))

    const after = await db
      .select({ n: sql<string>`count(*)` })
      .from(journalLines)
      .where(eq(journalLines.companyId, fixture.companyId))

    expect(after[0].n).toBe(before[0].n)
    expect(Number(after[0].n)).toBeGreaterThan(0)
  })

  it('reports what every policy holds without deleting any of it', async () => {
    await recordLoginAttempt({ email: 'old@example.test', outcome: 'wrong_password' })
    await db
      .update(loginAttempts)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(loginAttempts.email, 'old@example.test'))

    const report = await retentionReport(DEPLOYMENT, new Date('2026-06-15T00:00:00Z'))
    expect(report.length).toBe(RETENTION_POLICIES.length)

    // Counting is a separate query from deleting on purpose: a number nobody
    // can check before the delete is a number nobody can dispute after it.
    expect(await db.select({ id: loginAttempts.id }).from(loginAttempts)).toHaveLength(1)
    const attempts = report.find((row) => row.kind === 'login_attempts')!
    expect(attempts.counted && attempts.expired).toBe(1)
  })

  it('deletes an old guard attempt and leaves the ones still being counted', async () => {
    const fixture = await createCompanyFixture({ name: 'Guarded Co' })

    await db.insert(guardAttempts).values([
      { userId: fixture.userId, act: 'address.claim', ok: false, createdAt: new Date('2020-01-01T00:00:00Z') },
      { userId: fixture.userId, act: 'address.claim', ok: true, createdAt: new Date('2026-06-14T23:50:00Z') },
    ])

    const asOf = new Date('2026-06-15T00:00:00Z')
    expect((await sweepOne('guard_attempts', asOf)).removed).toBe(1)

    // The successful one is ten minutes old, inside the fifteen-minute
    // cool-off window — and it is the row that clears a run of failures. A
    // sweep on a year-old cutoff must not be able to reach what the guard is
    // still reading.
    const left = await db.select({ ok: guardAttempts.ok }).from(guardAttempts)
    expect(left.map((row) => row.ok)).toEqual([true])
  })

  it('sweeps every policy in one pass', async () => {
    const results = await sweepAll(new Date('2026-06-15T00:00:00Z'))
    expect(results.map((row) => row.kind).sort()).toEqual(
      RETENTION_POLICIES.map((policy) => policy.kind).sort(),
    )
  })
})

describe('the schedules that were owed', () => {
  it('registers a handler for every schedule, and schedules every new handler', () => {
    const kinds = new Set(registeredKinds().map((handler) => handler.kind))

    // A schedule with no handler fires a job that dead-letters every day; a
    // handler with no schedule is the gap five phases each wrote a README
    // bullet about.
    for (const schedule of [...COMPANY_SCHEDULES, ...GLOBAL_SCHEDULES]) {
      expect(kinds.has(schedule.kind)).toBe(true)
    }

    const scheduled = new Set(
      [...COMPANY_SCHEDULES, ...GLOBAL_SCHEDULES].map((schedule) => schedule.kind),
    )
    for (const kind of [
      'housekeeping.retention',
      'engagement.chase_overdue',
      'properties.run_rent',
      'ops.failure_digest',
    ]) {
      expect(scheduled.has(kind)).toBe(true)
    }
  })

  it('marks the housekeeping ones global and the rest per company', () => {
    const handlers = new Map(registeredKinds().map((handler) => [handler.kind, handler]))

    expect(handlers.get('housekeeping.retention')?.global).toBe(true)

    // `global` is optional, so "per company" is the absence of it — asserted
    // as falsy rather than as `false`, which is what the registry actually
    // stores for a handler that never said.
    //
    // The digest is per company because dead jobs and bounced letters belong
    // to a tenant, and because there is no deployment operator to page.
    for (const kind of ['ops.failure_digest', 'engagement.chase_overdue', 'properties.run_rent']) {
      expect(handlers.get(kind)).toBeDefined()
      expect(handlers.get(kind)?.global ?? false).toBe(false)
    }
  })
})

/**
 * Recipients in whatever states the test needs, without running a campaign:
 * the question is what the rates say, not how the rows got there.
 */
/** A `YYYY-MM-DD` that many days back, for seeding readings. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function seedSending(
  companyId: string,
  counts: { accepted: number; bounced?: number; complained?: number; name?: string },
) {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      companyId,
      name: counts.name ?? 'Reputation',
      kind: 'broadcast',
      status: 'sent',
    })
    .returning()

  const bounced = counts.bounced ?? 0
  const complained = counts.complained ?? 0
  const now = new Date()

  const rows = Array.from({ length: counts.accepted }, (_, index) => ({
    companyId,
    campaignId: campaign.id,
    email: `reader${index}@example.test`,
    unsubscribeToken: `tok-${campaign.id}-${index}`,
    status:
      index < bounced
        ? ('bounced' as const)
        : index < bounced + complained
          ? ('complained' as const)
          : ('delivered' as const),
    sentAt: now,
  }))

  await db.insert(campaignRecipients).values(rows)
}

describe('the failure digest', () => {
  it('finds a dead job and a bounced letter in one shape', async () => {
    const fixture = await createCompanyFixture({ name: 'Digest Co' })
    const now = new Date()

    await db.insert(backgroundJobs).values({
      companyId: fixture.companyId,
      kind: 'bank.sync_all',
      payload: {},
      status: 'dead',
      attempts: 5,
      maxAttempts: 5,
      lastError: 'The provider refused the token.',
      runAt: now,
      updatedAt: now,
      finishedAt: now,
    })

    await db.insert(transactionalMessages).values({
      companyId: fixture.companyId,
      kind: 'company_invitation',
      email: 'mistyped@exmaple.test',
      subject: 'You have been invited',
      outcome: 'failed',
      providerKey: 'mock',
      error: 'No such domain.',
    })

    const state = await health(fixture.ctx)

    expect(state.deadJobs).toHaveLength(1)
    expect(state.bouncedMail).toHaveLength(1)
    expect(state.total).toBe(2)
    expect(state.bouncedMail[0].email).toBe('mistyped@exmaple.test')
  })

  it('says nothing on a quiet day', async () => {
    const fixture = await createCompanyFixture({ name: 'Quiet Co' })
    const state = await health(fixture.ctx)

    // The whole point of the digest. One that fires on a quiet day teaches
    // people to ignore the one that fires on a loud one.
    expect(state.total).toBe(0)
    expect(state.worthSaying).toBe(false)

    // And a company that has sent nothing has no sending verdict at all —
    // which is not the same as a healthy one (Phase 84).
    expect(state.sending).toBeNull()
    // Nothing to attribute, and the breakdown query is never run (Phase 85).
    expect(state.culprit).toBeNull()
  })

  /**
   * The one failure here that gets worse while nobody does anything about it
   * (Phase 84). Nothing has *failed* — the mail was accepted and delivered to
   * a mailbox that then rejected it — so a digest keyed on a count of failures
   * would stay silent until the sending domain was already spent.
   */
  it('speaks when the sending reputation is going bad, though nothing failed', async () => {
    const fixture = await createCompanyFixture({ name: 'Reputation Co' })
    await seedSending(fixture.companyId, { accepted: 200, bounced: 12 })

    const state = await health(fixture.ctx)

    expect(state.total).toBe(0)
    expect(state.sending?.level).toBe('urgent')
    expect(state.sending?.concern).toBe('6.0% of mail is bouncing')
    expect(state.worthSaying).toBe(true)
  })

  it('will not cry wolf over a handful of recipients', async () => {
    const fixture = await createCompanyFixture({ name: 'Small Co' })
    await seedSending(fixture.companyId, { accepted: 20, bounced: 4 })

    const state = await health(fixture.ctx)

    // A 20% bounce rate over twenty sends is not a signal about anything.
    expect(state.sending).toBeNull()
    expect(state.worthSaying).toBe(false)
    expect(state.culprit).toBeNull()
  })

  /**
   * Phase 85. Knowing the domain is in trouble and knowing which send did it
   * are different facts, and only the second one can be acted on.
   */
  it('names the send that did it', async () => {
    const fixture = await createCompanyFixture({ name: 'Attribution Co' })
    await seedSending(fixture.companyId, {
      name: 'Conference badges',
      accepted: 200,
      bounced: 24,
    })
    await seedSending(fixture.companyId, { name: 'Newsletter', accepted: 200, bounced: 2 })

    const state = await health(fixture.ctx)

    expect(state.sending?.level).toBe('urgent')
    expect(state.culprit?.name).toBe('Conference badges')
    // Without it, 1% — the rest of the company's mail is fine.
    expect(state.culprit?.explainsIt).toBe(true)
    expect(state.culprit?.withoutItBounceRateBp).toBe(100)
  })

  /**
   * Phase 86. Knowing the rate and knowing which way it is going are different
   * facts: 3% that was 1% is a domain sliding, 3% that was 6% is somebody's fix
   * working, and telling them to clean the list again undoes it.
   */
  it('says which way it is going once there are two readings a window apart', async () => {
    const fixture = await createCompanyFixture({ name: 'Trend Co' })
    await seedSending(fixture.companyId, { accepted: 400, bounced: 24 })

    // Last week it was worse. The reading is written, not derived.
    await db.insert(sendingSnapshots).values([
      {
        companyId: fixture.companyId,
        takenOn: daysAgo(9),
        windowDays: 7,
        accepted: 400,
        bounced: 60,
        complained: 0,
      },
      {
        companyId: fixture.companyId,
        takenOn: daysAgo(0),
        windowDays: 7,
        accepted: 400,
        bounced: 24,
        complained: 0,
      },
    ])

    const state = await health(fixture.ctx)

    expect(state.sending?.level).toBe('urgent')
    expect(state.trend?.direction).toBe('improving')
    expect(state.trend?.summary).toBe('bounces down from 15.0% to 6.0% over 9 days')
  })

  it('knows nothing about the direction on a company with one reading', async () => {
    const fixture = await createCompanyFixture({ name: 'New Co' })
    await seedSending(fixture.companyId, { accepted: 400, bounced: 24 })

    await db.insert(sendingSnapshots).values({
      companyId: fixture.companyId,
      takenOn: daysAgo(0),
      windowDays: 7,
      accepted: 400,
      bounced: 24,
      complained: 0,
    })

    const state = await health(fixture.ctx)

    // "We do not know yet" is not "it is steady".
    expect(state.sending?.level).toBe('urgent')
    expect(state.trend).toBeNull()
  })

  /**
   * A record that holds only the bad days is blank on exactly the days that
   * are the baseline — the flaw in the accidental history
   * `background_jobs.result` has kept since Phase 84.
   */
  it('writes the reading down on a quiet day too', async () => {
    const fixture = await createCompanyFixture({ name: 'Snapshot Co' })
    const handler = getHandler('ops.failure_digest')!

    const result = (await handler.handler({
      actor: fixture.ctx,
      companyId: fixture.companyId,
      payload: { asOf: '2026-09-01T07:00:00.000Z' },
      attempt: 1,
      jobId: 'test',
    })) as Record<string, unknown>

    // Nothing wrong, nothing sent — and a row all the same.
    expect(result.sent).toBe(0)

    const rows = await db
      .select()
      .from(sendingSnapshots)
      .where(eq(sendingSnapshots.companyId, fixture.companyId))

    expect(rows).toHaveLength(1)
    expect(rows[0].takenOn).toBe('2026-09-01')
    expect(rows[0].accepted).toBe(0)
    expect(rows[0].windowDays).toBe(7)
  })

  /** A worker restart runs the digest twice; the day has one reading. */
  it('records one reading per day however often the digest fires', async () => {
    const fixture = await createCompanyFixture({ name: 'Retry Co' })
    await seedSending(fixture.companyId, { accepted: 400, bounced: 24 })

    const handler = getHandler('ops.failure_digest')!
    const fire = () =>
      handler.handler({
        actor: fixture.ctx,
        companyId: fixture.companyId,
        payload: { asOf: '2026-09-01T07:00:00.000Z' },
        attempt: 1,
        jobId: 'test',
      })

    await fire()
    await fire()

    const rows = await db
      .select()
      .from(sendingSnapshots)
      .where(eq(sendingSnapshots.companyId, fixture.companyId))

    expect(rows).toHaveLength(1)
    expect(rows[0].bounced).toBe(24)
  })

  it('keeps one company’s readings out of another’s trend', async () => {
    const mine = await createCompanyFixture({ name: 'Mine' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })
    await seedSending(mine.companyId, { accepted: 400, bounced: 24 })

    await db.insert(sendingSnapshots).values([
      {
        companyId: theirs.companyId,
        takenOn: daysAgo(9),
        windowDays: 7,
        accepted: 400,
        bounced: 4,
        complained: 0,
      },
      {
        companyId: mine.companyId,
        takenOn: daysAgo(0),
        windowDays: 7,
        accepted: 400,
        bounced: 24,
        complained: 0,
      },
    ])

    const state = await health(mine.ctx)

    // Their history is not our baseline.
    expect(state.trend).toBeNull()
  })

  /**
   * A uniformly bad list has no culprit, and naming the biggest campaign in it
   * would be naming the biggest campaign rather than the cause.
   */
  it('names nobody when every campaign is as bad as the rest', async () => {
    const fixture = await createCompanyFixture({ name: 'Rotten List Co' })
    await seedSending(fixture.companyId, { name: 'One', accepted: 200, bounced: 12 })
    await seedSending(fixture.companyId, { name: 'Two', accepted: 200, bounced: 12 })

    const state = await health(fixture.ctx)

    expect(state.sending?.level).toBe('urgent')
    expect(state.culprit).toBeNull()
  })

  it('does not report the same failure every morning', async () => {
    const fixture = await createCompanyFixture({ name: 'Window Co' })
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)

    await db.insert(transactionalMessages).values({
      companyId: fixture.companyId,
      kind: 'password_reset',
      email: 'ancient@example.test',
      subject: 'Reset your password',
      outcome: 'failed',
      providerKey: 'mock',
      error: 'Mailbox full.',
      createdAt: old,
    })

    // A month-old bounce is not today's news.
    expect((await health(fixture.ctx)).total).toBe(0)
    expect(
      (await health(fixture.ctx, { since: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) })).total,
    ).toBe(1)
  })

  it('needs the permission that administers the company', async () => {
    const fixture = await createCompanyFixture({ name: 'Locked Co' })
    const bookkeeper = { ...fixture.ctx, role: 'bookkeeper' as const }

    await expect(health(bookkeeper)).rejects.toBeInstanceOf(PermissionError)
  })

  it('keeps one company’s failures off another’s digest', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Digest Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Digest Co' })

    await db.insert(transactionalMessages).values({
      companyId: theirs.companyId,
      kind: 'password_reset',
      email: 'theirs@example.test',
      subject: 'Reset',
      outcome: 'failed',
      providerKey: 'mock',
      error: 'Bounced.',
    })

    expect((await health(ours.ctx)).total).toBe(0)
    expect((await health(theirs.ctx)).total).toBe(1)
  })
})

describe('chasing what was promised', () => {
  it('counts a person’s late follow-ups rather than listing them one by one', async () => {
    const fixture = await createCompanyFixture({ name: 'Chase Co' })

    await createTask(fixture.ctx, {
      title: 'Ring them back',
      dueOn: '2026-03-01',
      assignedTo: fixture.userId,
    })
    await createTask(fixture.ctx, {
      title: 'Send the revised quote',
      dueOn: '2026-03-05',
      assignedTo: fixture.userId,
    })
    await createTask(fixture.ctx, { title: 'Nobody has claimed this', dueOn: '2026-03-02' })
    await createTask(fixture.ctx, {
      title: 'Not late yet',
      dueOn: '2026-12-01',
      assignedTo: fixture.userId,
    })

    const overdue = await openWork(fixture.ctx, { asOf: '2026-03-10', overdueOnly: true })

    // What the handler groups: two for one person, one with nobody's name on.
    expect(overdue).toHaveLength(3)
    expect(overdue.filter((task) => task.assignedTo === fixture.userId)).toHaveLength(2)
    expect(overdue.filter((task) => task.assignedTo === null)).toHaveLength(1)
  })
})
