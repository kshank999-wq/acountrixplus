import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { historyFor } from '@/modules/audit'
import { permissionToRead } from '@/modules/audit/visibility'
import { listProjects } from '@/modules/crm/conversion'
import { Refusal } from '@/modules/errors'
import { RegistryError } from '@/modules/errors/registry'
import {
  JOB_STATES,
  bookableStatuses,
  jobState,
  setJobStatus,
  transitionRefusal,
  type JobStatus,
} from '@/modules/jobs/lifecycle'
import { wipSummary, workInProgress } from '@/modules/jobs/reports'
import { postManualEntry } from '@/modules/ledger/journal'
import { ROLE_PERMISSIONS, type Role } from '@/modules/permissions'
import {
  COLUMN_WRITERS,
  columnWriterFor,
  insertOnlyColumns,
  paintedStates,
  writerCandidates,
} from '@/modules/source/column-writers'
import { withoutComments } from '@/modules/source/enclosing'
import { sourceFiles } from '@/modules/source/isolation-scan'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * The job that cannot be finished (Phase 212).
 *
 * ADR 0211 nominated `projects.end_date` — no writer, so a job can be created,
 * billed, have its retainage held and its costs coded, and there is no way to
 * say it is over — with the instruction to measure *"what else is a finished
 * job supposed to mean?"* before building anything.
 *
 * Three things came out of that measurement, in increasing order of how much
 * they mattered.
 *
 * **The nomination's own reason was false.** It said the column *"is read — the
 * register's entry for it names what reads it"*, and the register's entry said
 * `jobs/reports.ts` *"reads the end date into every date range it builds"*. It
 * does not: that file's one `endDate` is a function parameter, a caller-supplied
 * window for a ledger query. Nothing in `src/` names `projects.endDate`.
 *
 * **The column that was waiting for an answer was `status`.** Four values in
 * the enum, one ever written — the literal `'active'`, which is also its
 * default — and the WIP schedule's own filter reads it.
 *
 * **And the WIP filter is not cosmetic.** `wipSummary` feeds the draft
 * period-end entry against `1160`, `2560` and `4200`, so a job dropping off the
 * schedule takes its share of a posted adjustment with it. That is why
 * completion does not remove a job from the schedule and being *settled* does.
 */

let fixture: Fixture & { job: { id: string; code: string } }

beforeEach(async () => {
  const company = await createCompanyFixture({ industry: 'construction' })
  const [job] = await db
    .insert(projects)
    .values({
      companyId: company.companyId,
      code: 'JOB-1001',
      name: 'Harborview Renovation',
      contractValueCents: 20_000_000,
      startDate: '2026-01-05',
    })
    .returning()

  fixture = { ...company, job }
})

/** Posts revenue against the job, which is what makes it over-billed. */
async function bill(cents: number) {
  const revenue = await fixture.account('4000')
  const cash = await fixture.account('1000')

  return postManualEntry(fixture.ctx, {
    entryDate: '2026-03-01',
    memo: 'Progress billing',
    lines: [
      { chartAccountId: cash.id, debitCents: cents },
      { chartAccountId: revenue.id, creditCents: cents, projectId: fixture.job.id },
    ],
  })
}

/** Takes the billing back off, which is how an over-billed job is squared. */
async function creditBack(cents: number) {
  const revenue = await fixture.account('4000')
  const cash = await fixture.account('1000')

  return postManualEntry(fixture.ctx, {
    entryDate: '2026-07-01',
    memo: 'Credit note',
    lines: [
      { chartAccountId: revenue.id, debitCents: cents, projectId: fixture.job.id },
      { chartAccountId: cash.id, creditCents: cents },
    ],
  })
}

// --- The register ----------------------------------------------------------

describe('the four states, and what each one means to a reader', () => {
  it('argues for every entry', () => {
    for (const state of JOB_STATES) {
      // A sentence, not a word. Every flag on an entry is read by something,
      // so an entry that does not say why is four decisions nobody made.
      expect(state.because.length, state.status).toBeGreaterThan(200)
      // Rendered inside a sentence on the job page, so no capital and no
      // phase number — those belong in the code, never in the copy.
      expect(state.label, state.status).toBe(state.label.toLowerCase())
      expect(state.label, state.status).not.toMatch(/Phase/i)
    }
  })

  it('has no two states a reader cannot tell apart', () => {
    /**
     * The property that makes four values the right number rather than a
     * number somebody picked. `active` and `on_hold` differ only in whether
     * you may book time; `complete` and `cancelled` only in whether a cost may
     * still arrive. Take either distinction away and the enum has a member
     * that means exactly what another member means — which is the shape this
     * codebase keeps removing, arriving from the data side.
     */
    const shapes = JOB_STATES.map((state) =>
      [state.terminal, state.bookable, state.reportsWip, state.acceptsCosts].join('/'),
    )

    expect(new Set(shapes).size).toBe(JOB_STATES.length)
  })

  it('names exactly the statuses the column allows', () => {
    // Two answers to one question is the defect. The enum is the database's
    // list and the register is the application's; a status in one and not the
    // other is a state something reads as whatever the defaults happen to be.
    const schema = readFileSync('src/db/schema/crm.ts', 'utf8')
    const at = schema.indexOf("export const projects = pgTable")
    const block = schema.slice(at, schema.indexOf('export const', at + 20))
    const declared = /status: text\('status', \{ enum: \[([^\]]*)\] \}\)/
      .exec(block)![1]
      .split(',')
      .map((entry) => entry.trim().replace(/'/g, ''))

    expect(declared).toEqual(JOB_STATES.map((state) => state.status))
  })

  it('refuses a status nobody has placed', () => {
    expect(() => jobState('archived')).toThrow(RegistryError)
    // And the refusal says what to write, not that something went wrong.
    expect(() => jobState('archived')).toThrow(/whether a job in this state carries an end date/)
  })

  it('leaves no state that cannot be reached', () => {
    /**
     * Phase 185's shape, applied to a state machine: a declared state with no
     * way into it is a limitation that outlived its reason, and the register
     * would go on describing it to readers that could never see it.
     */
    for (const state of JOB_STATES) {
      expect(state.from.length, state.status).toBeGreaterThan(0)
      expect(
        JOB_STATES.some((other) => other.from.includes(state.status)),
        state.status,
      ).toBe(true)
    }
  })

  it('tells somebody which state to go through', () => {
    // A finished job was not called off, so the move is refused — and the
    // refusal names the way round rather than just saying no (Phase 47).
    expect(transitionRefusal('complete', 'cancelled')).toBe(
      'A complete job cannot be marked cancelled. Put it back to active first.',
    )
    expect(transitionRefusal('active', 'active')).toBe('This job is already active.')
    expect(transitionRefusal('active', 'complete')).toBeNull()
    expect(transitionRefusal('cancelled', 'active')).toBeNull()
  })

  it('offers the timesheet exactly the bookable states', () => {
    expect(bookableStatuses()).toEqual(['active'])
    expect(bookableStatuses()).toEqual(
      JOB_STATES.filter((state) => state.bookable).map((state) => state.status),
    )
  })
})

// --- The measurement -------------------------------------------------------

describe('a state nothing could change', () => {
  it('reports the states that survive the test, and why each one does', () => {
    /**
     * The narrowing device `insertOnlyColumns` has wanted since Phase 202,
     * asserted on its survivors rather than on a count, because the survivors
     * are the argument: three columns written only as literals, each fine for
     * a different reason, and that is what makes one finding a finding rather
     * than a quota.
     */
    const states = paintedStates()

    expect(
      states.map((row) => `${row.table}.${row.column} ${row.written.join('|')} ${row.fallback}`),
    ).toEqual([
      // No default, and both of its two values are written.
      "accountant_exports.result 'generated'|'held' null",
      // Defaults to false and is written true, so the write *is* the distinction.
      'progress_billings.isRetainageRelease true false',
      // No default, and both of its two values are written.
      "refunds.direction 'out'|'in' null",
    ])

    // None of them is painted on, and `projects.status` is gone from this list
    // because it has an `.update` now rather than because the rule changed.
    expect(states.filter((row) => row.painted)).toEqual([])
    expect(states.map((row) => `${row.table}.${row.column}`)).not.toContain('projects.status')
  })

  it('leaves the insert-only limitation where it was, one column smaller', () => {
    // 1,169 until this phase. The point was never the number — see the
    // docstring on `insertOnlyColumns`, which said for ten phases that it had
    // no way to ask which of these columns are state rather than record.
    expect(insertOnlyColumns()).toBe(1168)
  })

  it('has one writer for the status, and one insert that set it to its default', () => {
    /**
     * The before and after of the finding, read off the source, because the
     * measurement that found it cannot be re-run against a tree where the
     * column already has a writer.
     */
    const inserts: string[] = []
    const updates: string[] = []

    for (const dir of ['src/modules', 'src/app'] as const) {
      for (const file of sourceFiles(dir)) {
        const source = withoutComments(readFileSync(file, 'utf8'))
        if (/\.insert\(projects\)/.test(source)) inserts.push(file)
        if (/\.update\(projects\)/.test(source)) updates.push(file)
      }
    }

    // One insert, and the status it writes is the literal that is also the
    // column's schema default — which is the whole of the finding.
    expect(inserts).toEqual(['src/modules/crm/conversion.ts'])
    expect(withoutComments(readFileSync(inserts[0], 'utf8'))).toContain("status: 'active',")

    // Two updates: the change order that adds to the contract value, which is
    // the one that existed, and the act that moves the state.
    expect(updates.sort()).toEqual([
      'src/modules/jobs/budgets.ts',
      'src/modules/jobs/lifecycle.ts',
    ])
    // And the one that existed still writes only the contract value, so the
    // status has exactly one writer rather than two that could disagree.
    const budgets = withoutComments(readFileSync('src/modules/jobs/budgets.ts', 'utf8'))
    const at = budgets.indexOf('.update(projects)')
    expect(budgets.slice(at, budgets.indexOf('.where(', at))).not.toContain('status')
  })

  it('took the two columns off the register rather than rewording the entry', () => {
    // The register's rule in both directions: a closed finding is absent,
    // because the scan no longer reports it.
    expect(() => columnWriterFor('projects', 'endDate')).toThrow(RegistryError)
    expect(() => columnWriterFor('projects', 'notes')).toThrow(RegistryError)
    expect(COLUMN_WRITERS.map((entry) => entry.table)).not.toContain('projects')

    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)
    expect(candidates).not.toContain('projects.end_date')
    expect(candidates).not.toContain('projects.endDate')
    expect(candidates).not.toContain('projects.notes')
  })

  it('keeps the sentence that was false, where the entry used to be', () => {
    /**
     * Phase 185 and ADR 0134 together: the entry is gone because the finding
     * is closed, and the *reason* it gave is kept because it was wrong in a
     * way worth knowing about — Phase 210 taught the scan that a projectionless
     * `select()` is a read, and the next entry written used "it is read" as an
     * argument about a column no reader consults.
     */
    const register = readFileSync('src/modules/source/column-writers.ts', 'utf8')

    expect(register).toContain('reads the end date into')
    expect(register).toContain('jobs/lifecycle.ts')
  })
})

// --- The act ---------------------------------------------------------------

describe('the job that cannot be finished', () => {
  it('starts active, with no end date, and can be told it is over', async () => {
    const [before] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, fixture.job.id))

    expect(before.status).toBe('active')
    expect(before.endDate).toBeNull()

    const closed = await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'complete',
      effectiveDate: '2026-06-30',
      note: 'Snagging signed off by the client.',
    })

    expect(closed.status).toBe('complete')
    expect(closed.endDate).toBe('2026-06-30')
    expect(closed.notes).toBe('Snagging signed off by the client.')
  })

  it('clears the end date when a job goes back to work', async () => {
    // The contradiction this would otherwise store: a job with an end date
    // that is running. One act, so the two columns cannot disagree.
    await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'complete',
      effectiveDate: '2026-06-30',
    })

    const reopened = await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'active',
    })

    expect(reopened.status).toBe('active')
    expect(reopened.endDate).toBeNull()
  })

  it('refuses an end date in the future', async () => {
    await expect(
      setJobStatus(fixture.ctx, {
        projectId: fixture.job.id,
        status: 'complete',
        effectiveDate: '2099-01-01',
      }),
    ).rejects.toThrow(/A job is closed once it has finished/)
  })

  it('refuses an end date before the job started', async () => {
    await expect(
      setJobStatus(fixture.ctx, {
        projectId: fixture.job.id,
        status: 'cancelled',
        effectiveDate: '2026-01-01',
      }),
    ).rejects.toThrow(/started on 2026-01-05, so it cannot have been cancelled on 2026-01-01/)
  })

  it('refuses a move the register does not allow', async () => {
    await setJobStatus(fixture.ctx, { projectId: fixture.job.id, status: 'complete' })

    await expect(
      setJobStatus(fixture.ctx, { projectId: fixture.job.id, status: 'cancelled' }),
    ).rejects.toThrow(/Put it back to active first/)

    await expect(
      setJobStatus(fixture.ctx, { projectId: fixture.job.id, status: 'complete' }),
    ).rejects.toThrow(/already complete/)
  })

  it('leaves the note alone when none is given', async () => {
    await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'on_hold',
      note: 'Waiting on the party wall award.',
    })

    const back = await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'active',
    })

    expect(back.notes).toBe('Waiting on the party wall award.')
  })

  it('records the pair of states, not just the new one', async () => {
    await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'complete',
      effectiveDate: '2026-06-30',
      note: 'Done.',
    })

    const [event] = await historyFor(fixture.ctx, 'job', fixture.job.id)

    expect(event.action).toBe('job.status')
    expect(event.before).toEqual({ status: 'active', endDate: null, notes: null })
    expect(event.after).toEqual({
      status: 'complete',
      endDate: '2026-06-30',
      notes: 'Done.',
    })
  })

  it('needs jobs:manage, which the people who read jobs do not all hold', async () => {
    const viewer = await addUserWithRole(fixture, 'readonly')

    await expect(
      setJobStatus(viewer, { projectId: fixture.job.id, status: 'complete' }),
    ).rejects.toThrow(/permission/i)
  })

  it('cannot close another company’s job', async () => {
    const other = await createCompanyFixture({ industry: 'construction' })

    await expect(
      setJobStatus(other.ctx, { projectId: fixture.job.id, status: 'complete' }),
    ).rejects.toThrow()

    const [untouched] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, fixture.job.id))

    expect(untouched.status).toBe('active')
  })
})

// --- The three readers -----------------------------------------------------

describe('what a finished job means to the things that read it', () => {
  it('takes it out of the timesheet picker, and leaves it in the client’s list', async () => {
    /**
     * Reader two of ADR 0211's three, and it did not exist: `listProjects`
     * selected `status` and `/time/page.tsx` mapped it off the row on the way
     * into the dropdown. Opt-in rather than opt-out, because the CRM's client
     * panel wants every job a client has ever had.
     */
    expect((await listProjects(fixture.ctx, { bookableOnly: true })).map((p) => p.code)).toEqual([
      'JOB-1001',
    ])

    await setJobStatus(fixture.ctx, { projectId: fixture.job.id, status: 'complete' })

    expect(await listProjects(fixture.ctx, { bookableOnly: true })).toEqual([])
    expect((await listProjects(fixture.ctx)).map((p) => p.code)).toEqual(['JOB-1001'])
  })

  it('goes on taking costs when it is complete, because suppliers invoice late', async () => {
    // The argument in the register, asserted: a subcontractor's invoice for
    // the last week on site arrives after the last day on site, and refusing
    // it would push a real cost onto a job that did not incur it.
    await setJobStatus(fixture.ctx, { projectId: fixture.job.id, status: 'complete' })

    const labour = await fixture.account('5000')
    const cash = await fixture.account('1000')

    await expect(
      postManualEntry(fixture.ctx, {
        entryDate: '2026-07-15',
        memo: 'Final subcontractor invoice',
        lines: [
          { chartAccountId: labour.id, debitCents: 50_000, projectId: fixture.job.id },
          { chartAccountId: cash.id, creditCents: 50_000 },
        ],
      }),
    ).resolves.toBeTruthy()
  })

  it('refuses a cost coded to a cancelled job, and says when it was cancelled', async () => {
    /**
     * Reader three, which did not exist either: `assertDimensionsInCompany` —
     * the one place every posting's dimensions are checked — selected
     * `projects.id` and looked at nothing else.
     *
     * The date is in the message on purpose. "That job is cancelled" leaves
     * somebody guessing whether they have the wrong job or the wrong month.
     */
    await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'cancelled',
      effectiveDate: '2026-03-14',
    })

    const labour = await fixture.account('5000')
    const cash = await fixture.account('1000')

    await expect(
      postManualEntry(fixture.ctx, {
        entryDate: '2026-04-01',
        lines: [
          { chartAccountId: labour.id, debitCents: 50_000, projectId: fixture.job.id },
          { chartAccountId: cash.id, creditCents: 50_000 },
        ],
      }),
    ).rejects.toThrow(/JOB-1001 was cancelled on 2026-03-14, so a cost cannot be coded to it/)

    // And nothing was written: the whole entry rolls back with its line.
    const after = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, fixture.job.id), eq(projects.companyId, fixture.companyId)))

    expect(after[0].status).toBe('cancelled')
  })
})

// --- The invariant ---------------------------------------------------------

describe('the WIP schedule a closed job must not vanish from', () => {
  it('drops a job that is square and keeps one that is not', async () => {
    /**
     * The reason completion does not take a job off the schedule.
     *
     * `wipSummary` feeds `jobs.propose_wip_entry`, which drafts the period-end
     * entry against `1160 Costs in Excess of Billings`, `2560 Billings in
     * Excess of Costs` and `4200`. An accountant posts that entry in June; the
     * job is closed in July while still over-billed; the job leaves the
     * schedule; nothing ever proposes the reversal, and `2560` carries the
     * figure for good.
     *
     * So the register's `reportsWip` means *on the schedule whether or not
     * there is anything to report*, and a state that is off it stays on it
     * while the job's over/under-billing is non-zero. Being settled is what
     * takes a job off, which is what closing it was for.
     */
    await bill(100_000)

    const open = await workInProgress(fixture.ctx)
    expect(open.map((row) => row.code)).toEqual(['JOB-1001'])
    // No budget, so no earned revenue: everything billed is billed ahead.
    expect(open[0].overUnderBillingCents).toBe(100_000)

    await setJobStatus(fixture.ctx, {
      projectId: fixture.job.id,
      status: 'complete',
      effectiveDate: '2026-06-30',
    })

    const closedButOwing = await workInProgress(fixture.ctx)
    expect(closedButOwing.map((row) => row.code)).toEqual(['JOB-1001'])
    expect(closedButOwing[0].status).toBe('complete')
    // The date is why the row is defensible rather than confusing.
    expect(closedButOwing[0].endDate).toBe('2026-06-30')

    // And it is still in the figure the draft entry is built from.
    expect((await wipSummary(fixture.ctx)).billingsInExcessCents).toBe(100_000)

    // Square it off, and now it goes.
    await creditBack(100_000)

    expect(await workInProgress(fixture.ctx)).toEqual([])
    expect((await wipSummary(fixture.ctx)).billingsInExcessCents).toBe(0)
  })

  it('shows a closed job on its own page whatever its state', async () => {
    // `includeComplete` is what the job page passes, and until this phase it
    // was unreachable in the only way that mattered: nothing could produce a
    // job it would have made a difference to.
    await setJobStatus(fixture.ctx, { projectId: fixture.job.id, status: 'cancelled' })

    expect(await workInProgress(fixture.ctx)).toEqual([])
    expect(
      (await workInProgress(fixture.ctx, { projectId: fixture.job.id, includeComplete: true }))
        .length,
    ).toBe(1)
  })

  it('reads which states are on the schedule from the register', () => {
    // The literal pair this filter used to hold — `status === 'active' ||
    // status === 'on_hold'` — was a second copy of the register, in the one
    // reader that already existed.
    const source = withoutComments(readFileSync('src/modules/jobs/reports.ts', 'utf8'))

    expect(source).toContain('jobState(row.status).reportsWip')
    expect(source).not.toContain("'on_hold'")
  })
})

// --- Who may read what this writes -----------------------------------------

describe('the history of a job, and who is shown it', () => {
  it('places the job, so the person who closed it can read the record', () => {
    expect(permissionToRead('job')).toBe('jobs:view')
  })

  it('shows the record to every role that can produce one', () => {
    /**
     * Phase 78's finding, measured rather than assumed, because this phase is
     * the first to write an audit event about a job: *"an audit entry the
     * person who made the correction cannot see is not much of an audit
     * trail."* `bookkeeper` holds `jobs:manage` and does **not** hold
     * `audit:view`, so an unplaced `job` type would have hidden the record
     * from exactly the role most likely to be closing jobs.
     */
    const closers = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((role) =>
      ROLE_PERMISSIONS[role].includes('jobs:manage'),
    )

    expect(closers).toContain('bookkeeper')
    expect(ROLE_PERMISSIONS.bookkeeper).not.toContain('audit:view')

    for (const role of closers) {
      expect(ROLE_PERMISSIONS[role], role).toContain(permissionToRead('job'))
    }
  })

  it('takes nothing from the readers who could already see it', () => {
    // The other half of placing a type: every role holding `audit:view` also
    // holds `jobs:view`, so no reader loses a record they used to be shown.
    for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      if (!ROLE_PERMISSIONS[role].includes('audit:view')) continue
      expect(ROLE_PERMISSIONS[role], role).toContain('jobs:view')
    }
  })

  it('lets a bookkeeper read the history of the job they closed', async () => {
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await setJobStatus(bookkeeper, {
      projectId: fixture.job.id,
      status: 'complete',
      effectiveDate: '2026-06-30',
    })

    const history = await historyFor(bookkeeper, 'job', fixture.job.id)
    expect(history).toHaveLength(1)
    expect(history[0].action).toBe('job.status')
  })
})

// --- The vocabulary --------------------------------------------------------

describe('one action for four moves', () => {
  it('does not invent a word per transition', () => {
    /**
     * Phase 70: one vocabulary for a correction. `job.complete`, `job.cancel`,
     * `job.hold` and `job.reopen` would be four actions whose only difference
     * is already in `before` and `after`, and the screen that explains an
     * event would need four sentences to say the same thing.
     */
    const audit = readFileSync('src/modules/audit/index.ts', 'utf8')
    const actions = [...audit.matchAll(/\| '(job\.\w+)'/g)].map((m) => m[1])

    expect(actions).toEqual(['job.status'])
  })

  it('states every state the act can be given', () => {
    // The action's own input is the register's list, so a fifth state cannot
    // be added to one and not the other.
    const actions = withoutComments(readFileSync('src/app/actions/jobs.ts', 'utf8'))
    const listed = /status: z\.enum\(\[([^\]]*)\]\)/
      .exec(actions)![1]
      .split(',')
      .map((entry) => entry.trim().replace(/'/g, ''))
      .filter((entry) => entry.length > 0)

    expect(listed).toEqual(JOB_STATES.map((state) => state.status as JobStatus))
  })

  it('refuses rather than throws a bare Error', async () => {
    // Every refusal in this module is a sentence somebody can act on, which is
    // what `Refusal` means here as against `DomainError`.
    await expect(
      setJobStatus(fixture.ctx, {
        projectId: fixture.job.id,
        status: 'complete',
        effectiveDate: '2099-01-01',
      }),
    ).rejects.toBeInstanceOf(Refusal)
  })
})
