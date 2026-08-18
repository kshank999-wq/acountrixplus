import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { integrityFindings, integrityRuns } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { setModuleEnabled } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { postManualEntry } from '@/modules/ledger/journal'
import { addPractitioner, book, completeAppointment } from '@/modules/appointments/service'
import {
  INTEGRITY_CHECKS,
  checkHistory,
  isBroken,
  latestRun,
  newlyBroken,
  runIntegrityChecks,
  type Finding,
} from '@/modules/integrity/service'
import { getHandler } from '@/modules/worker/registry'
import { COMPANY_SCHEDULES, ensureSchedules } from '@/modules/worker/defaults'
import { listSchedules } from '@/modules/worker/schedules'
import '@/modules/worker/handlers'

/**
 * The books checking themselves (Phase 33).
 *
 * Five claims under test:
 *
 *  1. **Every reconciliation this codebase has is in the register**, and the
 *     register is what runs. A check added to a module and not to the register
 *     is a check nobody runs, which is the defect this phase exists to close.
 *  2. **A check that is expected to differ is not a fault.** Three positions
 *     legitimately diverge, and alarming on them would train somebody to
 *     ignore the alarm.
 *  3. **A check that could not run is not a check that passed.** Skipped and
 *     errored are recorded apart from agreeing.
 *  4. **One drift is one alarm.** Something wrong for a week does not send
 *     seven notifications.
 *  5. **What was wrong last night is on the record**, so "when did this start"
 *     has an answer.
 */

const APRIL = (hour: number) => new Date(Date.UTC(2026, 3, 1, hour, 0))

async function salon(): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name: 'Fenwick Row', industry: 'personal_care' })
  await setModuleEnabled(fixture.ctx, 'appointments', true)
  return fixture
}

/** A delivered visit, which puts a real invoice behind the control account. */
async function aVisit(fixture: Fixture, priceCents = 6_500) {
  const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })
  const appointment = await book(fixture.ctx, {
    practitionerId: sam.id,
    startsAt: APRIL(10),
    endsAt: APRIL(11),
    priceCents,
  })
  return completeAppointment(fixture.ctx, {
    appointmentId: appointment.id,
    completedOn: '2026-04-01',
  })
}

/** Breaks the receivables control account by hand, which nothing else can do. */
async function breakReceivables(fixture: Fixture, cents = 25_000) {
  const receivable = await accountByNumber(fixture.companyId, '1100')
  const revenue = await accountByNumber(fixture.companyId, '4000')

  await postManualEntry(fixture.ctx, {
    entryDate: '2026-04-02',
    memo: 'Somebody journalled straight at the control account',
    lines: [
      { chartAccountId: receivable!.id, debitCents: cents, creditCents: 0 },
      { chartAccountId: revenue!.id, debitCents: 0, creditCents: cents },
    ],
  })
}

function findingFor(findings: Finding[], key: string): Finding {
  const found = findings.find((row) => row.key === key)
  if (!found) throw new Error(`No finding for ${key}`)
  return found
}

describe('the register names every check there is (Phase 33)', () => {
  it('gives every check a stable key, a module gate and a severity', () => {
    const keys = INTEGRITY_CHECKS.map((check) => check.key)

    expect(new Set(keys).size).toBe(keys.length)

    for (const check of INTEGRITY_CHECKS) {
      expect(check.key).toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(check.label.length).toBeGreaterThan(10)
      // The meaning is what a person reads next to a number they were just
      // alarmed about. A check without one is a number with no argument.
      expect(check.meaning.length).toBeGreaterThan(30)
      expect(['fault', 'position']).toContain(check.severity)
    }
  })

  it('classifies the three positions that legitimately differ as positions', () => {
    const positions = INTEGRITY_CHECKS.filter((check) => check.severity === 'position').map(
      (check) => check.key,
    )

    // Practitioner payouts and tips both differ the moment payroll draws on
    // them; untagged contributions are non-zero whenever a charity receives
    // unrestricted money. Alarming on any of these would fire on ordinary
    // trading, and an alarm that fires on ordinary trading gets switched off.
    expect(positions.sort()).toEqual([
      'appointments.payouts',
      'funds.untagged_contributions',
      'pos.tips',
    ])
  })

  it('classifies everything else as a fault', () => {
    const faults = INTEGRITY_CHECKS.filter((check) => check.severity === 'fault').map(
      (check) => check.key,
    )

    // Listed by name on purpose: this is the tripwire that makes adding a check
    // — or reclassifying one — a deliberate act rather than something that
    // slips in. `cash_drawer.open_tills` joined in Phase 34 and failed here
    // first, which is the test doing its job.
    expect(faults.sort()).toEqual([
      'appointments.gift_cards',
      'assets.register',
      'cash_drawer.open_tills',
      'inventory.lots',
      'ledger.payables',
      'ledger.receivables',
      'manufacturing.wip',
      'properties.deposits',
      'vehicles.authorisations',
    ])
  })
})

describe('running the checks (Phase 33)', () => {
  it('runs the ungated checks on an empty company and finds nothing wrong', async () => {
    const fixture = await createCompanyFixture({ name: 'Quiet Books', industry: 'general' })
    const run = await runIntegrityChecks(fixture.ctx)

    expect(run.faults).toBe(0)
    expect(run.errors).toBe(0)

    // Every check in the register is accounted for: run or skipped, never
    // silently absent. Without this, a check that vanished from the loop would
    // read as a clean night.
    expect([...run.findings.map((row) => row.key), ...run.skipped].sort()).toEqual(
      INTEGRITY_CHECKS.map((check) => check.key).sort(),
    )
    expect(run.checksRun + run.checksSkipped).toBe(INTEGRITY_CHECKS.length)

    // The three every company gets, whatever industry it is.
    expect(run.findings.map((row) => row.key).sort()).toEqual([
      'assets.register',
      'ledger.payables',
      'ledger.receivables',
    ])

    for (const finding of run.findings) {
      expect(finding.error).toBeNull()
      expect(finding.agrees).toBe(true)
    }
  })

  it('skips a check whose module is switched off, and does not call that passing', async () => {
    const fixture = await createCompanyFixture({ name: 'Quiet Books', industry: 'general' })
    const run = await runIntegrityChecks(fixture.ctx)

    // A general-practice company keeps no diary, so the gift-card check is not
    // asked — and is absent from the findings rather than present and green.
    expect(run.skipped).toContain('appointments.gift_cards')
    expect(run.findings.map((row) => row.key)).not.toContain('appointments.gift_cards')
    expect(run.checksSkipped).toBeGreaterThan(0)
  })

  it('runs a module check once the module is on', async () => {
    const fixture = await salon()
    const run = await runIntegrityChecks(fixture.ctx)

    expect(run.skipped).not.toContain('appointments.gift_cards')
    expect(findingFor(run.findings, 'appointments.gift_cards').agrees).toBe(true)
  })

  it('catches a hand-written entry against a control account', async () => {
    const fixture = await salon()
    await aVisit(fixture)
    await breakReceivables(fixture, 25_000)

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = findingFor(run.findings, 'ledger.receivables')

    expect(finding.agrees).toBe(false)
    expect(finding.severity).toBe('fault')
    // The ledger is $250 higher than the documents behind it.
    expect(finding.differenceCents).toBe(-25_000)
    expect(run.faults).toBe(1)
  })

  it('does not count a position that differs as a fault', async () => {
    const fixture = await salon()
    // A delivered visit owes the practitioner their share, and nothing has
    // paid it — so earned and the 2320 balance agree here. The claim under
    // test is the classification, which holds either way.
    await aVisit(fixture)

    const run = await runIntegrityChecks(fixture.ctx)
    const payouts = findingFor(run.findings, 'appointments.payouts')

    expect(payouts.severity).toBe('position')
    expect(run.faults).toBe(0)
  })

  it('records a check that threw rather than swallowing it', async () => {
    const fixture = await salon()

    const exploding = {
      ...INTEGRITY_CHECKS[0],
      key: 'test.explodes',
      run: async () => {
        throw new Error('the column was renamed')
      },
    }

    INTEGRITY_CHECKS.push(exploding)
    try {
      const run = await runIntegrityChecks(fixture.ctx)
      const finding = findingFor(run.findings, 'test.explodes')

      expect(finding.error).toBe('the column was renamed')
      expect(run.errors).toBe(1)
      // `agrees: false` alongside an error is an admission, not an assertion —
      // and `isBroken` treats it as news either way.
      expect(finding.agrees).toBe(false)
      expect(isBroken(finding)).toBe(true)
      // A check that threw is not a fault: nobody knows whether they agree.
      expect(run.faults).toBe(0)
    } finally {
      INTEGRITY_CHECKS.pop()
    }
  })

  it('keeps running after one check throws', async () => {
    const fixture = await salon()

    const exploding = {
      ...INTEGRITY_CHECKS[0],
      key: 'test.explodes',
      run: async () => {
        throw new Error('nope')
      },
    }

    // Inserted first, so anything that stopped on it would report almost
    // nothing. The whole register has to come back.
    INTEGRITY_CHECKS.unshift(exploding)
    try {
      const run = await runIntegrityChecks(fixture.ctx)
      expect(run.findings.length).toBeGreaterThan(3)
      expect(findingFor(run.findings, 'ledger.receivables').error).toBeNull()
    } finally {
      INTEGRITY_CHECKS.shift()
    }
  })

  it('needs permission to read the accounts', async () => {
    const fixture = await salon()
    await expect(
      runIntegrityChecks({ ...fixture.ctx, role: 'sales' }),
    ).rejects.toBeInstanceOf(PermissionError)
  })

  it("keeps one company's findings out of another's", async () => {
    const first = await salon()
    const second = await salon()

    await aVisit(first)
    await breakReceivables(first)

    await runIntegrityChecks(first.ctx)
    await runIntegrityChecks(second.ctx)

    const theirs = await latestRun(second.ctx)
    expect(theirs!.faults).toBe(0)
    expect(findingFor(theirs!.findings, 'ledger.receivables').agrees).toBe(true)
  })
})

describe('what was wrong last night is on the record (Phase 33)', () => {
  it('writes a run and a finding for every check that ran', async () => {
    const fixture = await salon()
    const run = await runIntegrityChecks(fixture.ctx)

    const runs = await db
      .select()
      .from(integrityRuns)
      .where(eq(integrityRuns.companyId, fixture.companyId))

    expect(runs).toHaveLength(1)
    expect(runs[0].checksRun).toBe(run.checksRun)
    expect(runs[0].finishedAt).not.toBeNull()

    const rows = await db
      .select()
      .from(integrityFindings)
      .where(eq(integrityFindings.runId, run.id))

    expect(rows).toHaveLength(run.checksRun)
  })

  it('reads the latest run back, with the checks it skipped', async () => {
    const fixture = await createCompanyFixture({ name: 'Quiet Books', industry: 'general' })
    await runIntegrityChecks(fixture.ctx)

    const latest = await latestRun(fixture.ctx)

    expect(latest).not.toBeNull()
    expect(latest!.skipped).toContain('appointments.gift_cards')
    expect(latest!.findings.every((row) => row.agrees)).toBe(true)
  })

  it('says nothing has ever run rather than saying nothing is wrong', async () => {
    const fixture = await salon()
    expect(await latestRun(fixture.ctx)).toBeNull()
  })

  it('answers when a difference started', async () => {
    const fixture = await salon()
    await aVisit(fixture)

    await runIntegrityChecks(fixture.ctx)
    await breakReceivables(fixture, 25_000)
    await runIntegrityChecks(fixture.ctx)
    await runIntegrityChecks(fixture.ctx)

    const history = await checkHistory(fixture.ctx, 'ledger.receivables')

    expect(history).toHaveLength(3)
    // Newest first: broken, broken, and the clean night before it started.
    expect(history.map((row) => row.agrees)).toEqual([false, false, true])
  })

  it('leaves nothing behind on a dry run', async () => {
    const fixture = await salon()
    const run = await runIntegrityChecks(fixture.ctx, { persist: false })

    expect(run.checksRun).toBeGreaterThan(0)
    expect(await latestRun(fixture.ctx)).toBeNull()
  })
})

describe('one drift is one alarm (Phase 33)', () => {
  it('reports everything broken on the very first run', async () => {
    const fixture = await salon()
    await aVisit(fixture)
    await breakReceivables(fixture)

    const run = await runIntegrityChecks(fixture.ctx)
    const news = await newlyBroken(fixture.ctx, run)

    // Nothing to compare against, so a company whose books have never been
    // checked is told what is wrong with them.
    expect(news.map((row) => row.key)).toEqual(['ledger.receivables'])
  })

  it('says nothing the second night about the same drift', async () => {
    const fixture = await salon()
    await aVisit(fixture)
    await breakReceivables(fixture)

    const first = await runIntegrityChecks(fixture.ctx)
    expect(await newlyBroken(fixture.ctx, first)).toHaveLength(1)

    const second = await runIntegrityChecks(fixture.ctx)
    const news = await newlyBroken(fixture.ctx, second)

    // Still broken, still on the page, and the phone stays quiet. A drift that
    // notified nightly would train somebody to ignore the notification by
    // about the time a second one appeared.
    expect(second.faults).toBe(1)
    expect(news).toHaveLength(0)
  })

  it('speaks up when a second, different check breaks', async () => {
    const fixture = await salon()
    await aVisit(fixture)
    await breakReceivables(fixture)
    await runIntegrityChecks(fixture.ctx)

    const exploding = {
      ...INTEGRITY_CHECKS[0],
      key: 'test.explodes',
      run: async () => {
        throw new Error('a new problem')
      },
    }

    INTEGRITY_CHECKS.push(exploding)
    try {
      const run = await runIntegrityChecks(fixture.ctx)
      const news = await newlyBroken(fixture.ctx, run)

      expect(news.map((row) => row.key)).toEqual(['test.explodes'])
    } finally {
      INTEGRITY_CHECKS.pop()
    }
  })

  it('says nothing at all when nothing is wrong', async () => {
    const fixture = await salon()
    await aVisit(fixture)

    const first = await runIntegrityChecks(fixture.ctx)
    expect(await newlyBroken(fixture.ctx, first)).toHaveLength(0)

    const second = await runIntegrityChecks(fixture.ctx)
    expect(await newlyBroken(fixture.ctx, second)).toHaveLength(0)
  })
})

describe('the machine runs it (Phase 33)', () => {
  it('registers a handler and schedules it daily', () => {
    expect(getHandler('books.integrity_check')).toBeDefined()

    const schedule = COMPANY_SCHEDULES.find((row) => row.kind === 'books.integrity_check')
    expect(schedule).toBeDefined()
    expect(schedule!.cadence).toBe('daily')
  })

  it('gives a company its schedules without anybody installing them', async () => {
    const fixture = await salon()

    // The defect this closes: nothing but the seed ever called
    // `installCompanySchedules`, so a company created through the sign-up form
    // had no schedules at all — no bank sync, no rent run, no digest, and no
    // books check. A fixture is created the same way, so it starts with none.
    expect(await listSchedules(fixture.companyId)).toHaveLength(0)

    await ensureSchedules()

    const kinds = (await listSchedules(fixture.companyId)).map((row) => row.kind)
    expect(kinds).toContain('books.integrity_check')
    for (const schedule of COMPANY_SCHEDULES) {
      expect(kinds).toContain(schedule.kind)
    }
  })

  it('installs nothing on a second pass', async () => {
    await salon()
    await ensureSchedules()

    // Safe on every tick, which is what lets the worker call it unconditionally.
    const second = await ensureSchedules()
    expect(second.installed).toBe(0)
  })

  it('runs the checks and records them when the handler fires', async () => {
    const fixture = await salon()
    await aVisit(fixture)
    await breakReceivables(fixture)

    const handler = getHandler('books.integrity_check')!
    const result = (await handler.handler({
      actor: fixture.ctx,
      companyId: fixture.companyId,
      payload: {},
      attempt: 1,
      jobId: 'test',
    })) as Record<string, number>

    expect(result.faults).toBe(1)
    expect(result.newlyBroken).toBe(1)

    const latest = await latestRun(fixture.ctx)
    expect(latest!.faults).toBe(1)
  })

  it('is silent on a second firing, and still writes the run down', async () => {
    const fixture = await salon()
    await aVisit(fixture)
    await breakReceivables(fixture)

    const handler = getHandler('books.integrity_check')!
    const fire = () =>
      handler.handler({
        actor: fixture.ctx,
        companyId: fixture.companyId,
        payload: {},
        attempt: 1,
        jobId: 'test',
      }) as Promise<Record<string, number>>

    await fire()
    const second = await fire()

    expect(second.newlyBroken).toBe(0)
    expect(second.sent).toBe(0)
    // The run is still on the record. "No findings" and "the job stopped
    // firing three weeks ago" have to stay distinguishable, which is this
    // phase's own argument applied one level up.
    expect(second.faults).toBe(1)

    const runs = await db
      .select()
      .from(integrityRuns)
      .where(eq(integrityRuns.companyId, fixture.companyId))

    expect(runs).toHaveLength(2)
  })
})
