import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createCompanyFixture, type Fixture } from './helpers'
import { setModuleEnabled } from '@/modules/industry/modules'
import { db } from '@/db'
import { employees, practitioners, taxCodes } from '@/db/schema'
import {
  createEmployee,
  createPayrollRun,
  listEmployees,
  recordEmployment,
} from '@/modules/payroll/service'
import {
  createTaxCode,
  listTaxCodes,
  setTaxCodeActive,
  taxLinesFor,
} from '@/modules/payroll/sales-tax'
import {
  addPractitioner,
  book,
  listPractitioners,
  setPractitionerActive,
} from '@/modules/appointments/service'
import { getProfile, saveProfile } from '@/modules/studio/service'
import { addressLines } from '@/modules/brand/letterhead'
import { COLUMN_WRITERS, writerCandidates } from '@/modules/source/column-writers'
import { sourceFiles } from '@/modules/source/isolation-scan'
import { withoutComments } from '@/modules/source/enclosing'
import { Refusal } from '@/modules/errors'

/**
 * The switch the census could not see (Phase 210).
 *
 * ## The nomination, and what measuring it found
 *
 * ADR 0209 nominated *an employee who cannot leave*: `employees` had one insert
 * and no update, so `end_date` and `is_active` had no writer. True, and it is
 * the smaller half.
 *
 * The larger half is **why neither census could see it.** `writerCandidates`
 * asks which columns something reads that nothing writes, and its test for
 * *read* is `tableVar.column` named outside the schema. A projectionless
 * `select()` compiles to `select *` — it reads every column of the table and
 * names none of them — and the row's columns are then reached as properties,
 * `row.isActive`, which carry no table to key on. The scan skipped such a
 * column **before** applying any exclusion, so it could never be a candidate
 * however unwritable it was.
 *
 * Phase 202 narrowed this register's exclusion for defaulted columns and closed
 * *"all six `isActive` switches"* that narrowing exposed. The exclusion was
 * never what hid these. The **shape of the query** was.
 *
 * ## The measurement that makes it a class
 *
 * Thirty tables carry an `isActive`. **Twenty-five have a writer; five do not.**
 * And the five with no writer are exactly the five whose flag no query ever
 * names — a correlation of one, asserted below, and the reason this is a defect
 * in the method rather than five unrelated omissions. A module that filters
 * `row.isActive` in JavaScript is a module that never wrote the `set`.
 *
 * ## What this phase did about it
 *
 * Corrected the read rule: **29 candidates became 96**, of which 16 are written
 * by nothing and are declared as findings — the first this register has carried
 * since the verdict for one was created in Phase 201 and kept, unused, through
 * Phases 208 and 209 on Phase 157's rule.
 *
 * Then closed five, in the order their readers justified:
 *
 *  1. `practitioners.isActive` — `book` **refuses** on it, so the branch had
 *     been unreachable since Phase 3 and the message had never been shown.
 *  2. `employees.isActive` with `end_date` — and `createPayrollRun` now refuses
 *     a payslip for somebody who left before the period opened, which is the
 *     check ADR 0208 said was missing and could not have been written.
 *  3. `tax_codes.isActive` — Phase 209 passed `{ activeOnly: true }` to the
 *     invoice composer's picker and said in the comment beside it that the flag
 *     was inert.
 *  4. `company_profiles.addressLine2` and `country` — **the two columns this
 *     register was created for.** Phase 200 gave them a field on the form and
 *     the action's zod schema omitted them, so the box accepted typing,
 *     reported *"Company profile saved."* and dropped the value.
 *
 * And removed two: `segments.isActive` and `vehicles.isActive` had no reader
 * either, which is Phase 49's shape and takes a migration rather than an entry.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Harkness Plant Hire' })
})

/** Every file the two censuses read. */
function applicationSource(): string {
  return [...sourceFiles('src/modules'), ...sourceFiles('src/app')]
    .map((file) => withoutComments(readFileSync(file, 'utf8')))
    .join('\n')
}

/** One month's pay, in the shape `createPayrollRun` takes. */
function payslipFor(employeeId: string) {
  return {
    employeeId,
    lines: [
      { kind: 'earning' as const, label: 'Wages', amountCents: 140_000 },
      {
        kind: 'employee_tax' as const,
        label: 'Income tax withheld',
        amountCents: 28_000,
        agency: 'Revenue authority',
      },
      {
        kind: 'employer_tax' as const,
        label: 'Employer contribution',
        amountCents: 9_000,
        agency: 'Revenue authority',
      },
    ],
  }
}

describe('the rule the scan was missing', () => {
  it('counts a projectionless select as reading every column of its table', () => {
    /*
      The correction itself, asserted on the source because what it changes is
      a predicate rather than a figure. Both scans go through `readNames`, so
      the candidate census and the insert-only number move together — which is
      the point: they were understated by the same amount for the same reason.
    */
    const scan = readFileSync('src/modules/source/column-writers.ts', 'utf8')

    expect(scan).toContain('function readNames(')
    expect(scan).toContain('select\\(\\s*\\)[\\s\\S]{0,400}?\\.from\\(\\s*(\\w+)\\s*\\)')
    // Called by both, rather than a third copy of the loop.
    expect(scan.match(/readNames\(file, tables\)/g)).toHaveLength(2)
  })

  it('reports 95 candidates and declares every one of them', () => {
    /*
      29 before the correction. The 67 the number moves by is not new code — it
      is columns the scan had never looked at, and the register had to argue
      every one of them down or up. Pinned exactly rather than as a floor
      (Phase 126): a bound would pass against a scan that quietly stopped
      reading half the tree, which is the failure mode Phases 196–198 each
      found a version of.
    */
    const candidates = writerCandidates()
    // 96 when this phase measured it; 95 since Phase 211 dropped
    // `bill_lines.item_id` rather than filling it.
    expect(candidates).toHaveLength(95)

    const declared = new Set(
      COLUMN_WRITERS.flatMap((entry) => entry.columns.map((c) => `${entry.table}.${c}`)),
    )

    for (const candidate of candidates) {
      expect(declared.has(`${candidate.table}.${candidate.column}`), `${candidate.table}.${candidate.column}`).toBe(true)
    }
    // And nothing declared that the scan no longer reports (ADR 0134).
    expect([...declared].filter((key) => {
      const [table, column] = key.split('.')
      return !candidates.some((c) => c.table === table && c.column === column)
    })).toEqual([])
  })

  it('carries findings for the first time, and names what reads each one', () => {
    /*
      Phase 157's rule vindicated rather than hypothetical. The `unwritable`
      verdict was created in Phase 201, emptied in Phase 208, and kept on the
      argument that a register with no word for a finding cannot report the
      next one. Two phases later it was needed sixteen times.

      Fifteen now. Phase 211 took `bill_lines.item_id` off the list — not by
      fixing it, but by establishing that it had never been a defect: the
      receipt line already records what arrived, so the column was dropped and
      the finding became an argument in the schema where it used to sit.
    */
    const findings = COLUMN_WRITERS.filter((row) => row.verdict === 'unwritable')

    expect(findings).toHaveLength(13)
    expect(findings.flatMap((row) => row.columns)).toHaveLength(15)

    // The verdict means nothing writes it, so there is no writer to name.
    for (const finding of findings) {
      expect(finding.writtenBy, finding.table).toBe('')
      expect(finding.because.length, finding.table).toBeGreaterThan(120)
    }
  })

  it('excludes a generated column, because the database refuses a write to one', () => {
    /*
      Phase 202's test — a default that is the *whole answer* versus a starting
      value for a state — applied to a third case.
      `evidence_subjects.subject_type` and `subject_id` are GENERATED ALWAYS AS
      … STORED, so reporting them would be asking for an editor Postgres would
      reject. Without this, correcting the read rule would have added two
      candidates whose only honest entry is "the database writes it".
    */
    const scan = readFileSync('src/modules/source/column-writers.ts', 'utf8')
    expect(scan).toContain('generatedAlwaysAs\\(')

    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)
    expect(candidates).not.toContain('evidence_subjects.subjectType')
    expect(candidates).not.toContain('evidence_subjects.subjectId')
  })

  it('corrects the paragraph that had the observation and the wrong conclusion', () => {
    /*
      Phase 203 found this mechanism, in the mirror direction, named the exact
      file, and wrote *"conservative in the safe direction — a missed read
      loses a candidate"*. It does not lose a candidate, it loses a **finding**
      — and one of the sixteen is `ai_requests.cacheHit`, on the very table that
      paragraph used as its example.
    */
    const earlier = readFileSync('tests/where-the-money-went.test.ts', 'utf8')

    expect(earlier).not.toContain('conservative in the safe direction')
    expect(earlier).toContain('it loses a **finding**')

    expect(
      COLUMN_WRITERS.find((row) => row.table === 'ai_requests')?.verdict,
    ).toBe('unwritable')
  })
})

describe('the switch class, counted', () => {
  it('finds every unwritten flag inside the shape, with one table as the control', () => {
    /**
     * The measurement that makes this a defect in the method rather than five
     * unrelated omissions.
     *
     * Thirty tables carried an `isActive`. **Twenty-four name it in a query,
     * and all twenty-four have a writer. Six never name it, and five of those
     * six had none.** So every defect was inside the scan's blind spot, and
     * the spot was not large: six tables of thirty.
     *
     * The sixth is the control and it is why this is worth stating carefully.
     * `costCodes` has the identical shape — `listCostCodes` selects every row
     * and filters `row.isActive` in JavaScript, so no query names the column —
     * and `updateCostCode` writes it anyway. The query shape does not cause the
     * missing writer; it hides whether there is one, and in five cases out of
     * six there was not.
     */
    const named = (table: string) => applicationSource().includes(`${table}.isActive`)

    // Written, and inside the shape: the control.
    expect(named('costCodes')).toBe(false)
    expect(applicationSource()).toContain('{ isActive: input.isActive }')

    // Outside the shape, a sample across modules, every one with a writer.
    for (const table of ['cashDrawers', 'giftCards', 'memberships', 'practices', 'serviceItems']) {
      expect(named(table), table).toBe(true)
    }

    /*
      The three this phase gave writers to are still inside the shape, because
      a write by key does not name a column either: `recordEmployment` sets
      `{ isActive: … }` and reads through `eq(employees.id, …)`. That is the
      honest state of it — the scan sees these columns only through the
      corrected rule, and the assertion below is what keeps them visible.
    */
    for (const table of ['employees', 'practitioners', 'taxCodes']) {
      expect(named(table), table).toBe(false)
    }
  })

  it('leaves no isActive anywhere that something reads and nothing writes', () => {
    /*
      The invariant this phase buys, and the reason it is asserted through the
      census rather than by listing tables: with the read rule corrected, a
      projectionless select makes every `isActive` *read*, so any one without a
      writer becomes a candidate and has to be declared or fixed. A new table
      with a switch nothing can flip now fails here rather than in 209 phases.
    */
    const flags = writerCandidates().filter((row) => row.column === 'isActive')
    expect(flags).toEqual([])
  })

  it('removed the two that had no reader either, rather than excusing them', () => {
    /*
      Phase 49's shape. `segments.isActive` and `vehicles.isActive` were
      written by nothing and read by nothing — not a query, not a filter, not a
      screen — so a control for either would have been inventing a requirement
      to justify a column. Twenty-eight tables carry the flag now.
    */
    const schema = sourceFiles('src/db/schema')
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    for (const gone of ['segments', 'vehicles']) {
      const at = schema.indexOf(`export const ${gone} = pgTable`)
      const block = schema.slice(at, schema.indexOf('export const', at + 20))

      expect(block, gone).not.toMatch(/^\s{4}isActive:/m)
      // And the removal says why, where the column was (Phase 185).
      expect(block, gone).toContain('Phase 210')
    }

    const carrying = [...schema.matchAll(/export const (\w+) = pgTable/g)].filter((m) => {
      const block = schema.slice(m.index!, schema.indexOf('export const', m.index! + 20))
      return /^\s{4}isActive:/m.test(block)
    })

    expect(carrying).toHaveLength(28)
  })
})

describe('an employee who cannot leave', () => {
  it('records a departure as one act, so the date and the flag cannot disagree', async () => {
    const person = await createEmployee(fixture.ctx, {
      name: 'Imelda Frost',
      startDate: '2025-01-06',
      baseRateCents: 4_000,
      payBasis: 'hourly',
    })

    // The state before, which is what 209 phases of this table looked like.
    expect(person.isActive).toBe(true)
    expect(person.endDate).toBeNull()

    const left = await recordEmployment(fixture.ctx, {
      employeeId: person.id,
      endDate: '2026-09-30',
    })

    expect(left.endDate).toBe('2026-09-30')
    expect(left.isActive).toBe(false)

    // Both columns, read back from the row rather than from the return value.
    const [stored] = await db.select().from(employees).where(eq(employees.id, person.id))
    expect(stored.endDate).toBe('2026-09-30')
    expect(stored.isActive).toBe(false)
  })

  it('makes the opt-in filter mean something, which is what ADR 0208 measured', async () => {
    /*
      The payroll run page has passed `{ activeOnly: true }` since it was built,
      and ADR 0208 nominated the four callers of this flag on the strength of a
      departed employee appearing in its picker. Measured, every caller was
      already correct — the defect was that the predicate could not be made
      false. This is the same assertion from the other side.
    */
    const staying = await createEmployee(fixture.ctx, { name: 'Dov Hallam' })
    const leaving = await createEmployee(fixture.ctx, { name: 'Ruth Okonjo' })

    expect((await listEmployees(fixture.ctx, { activeOnly: true })).map((p) => p.name).sort())
      .toEqual(['Dov Hallam', 'Ruth Okonjo'])

    await recordEmployment(fixture.ctx, { employeeId: leaving.id, endDate: '2026-10-31' })

    expect((await listEmployees(fixture.ctx, { activeOnly: true })).map((p) => p.name))
      .toEqual(['Dov Hallam'])
    // The register still shows both, which is the whole reason the flag is opt-in.
    expect(await listEmployees(fixture.ctx)).toHaveLength(2)
    expect(staying.isActive).toBe(true)
  })

  it('refuses a leaving date in the future rather than storing a state nothing winds', async () => {
    /*
      `is_active` is stored, so a departure dated next month would need
      something to come along and flip it, and nothing would — the flag would
      read `true` beside a leaving date already in the row, which is the defect
      this phase removes rather than relocates. A constraint beats a state
      machine nobody winds (Phase 116), and the limitation is declared rather
      than hidden.
    */
    const person = await createEmployee(fixture.ctx, { name: 'Søren Vik' })

    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10)

    await expect(
      recordEmployment(fixture.ctx, { employeeId: person.id, endDate: future }),
    ).rejects.toThrow(Refusal)
    // Phase 47: the refusal names something actionable, which is the day itself.
    await expect(
      recordEmployment(fixture.ctx, { employeeId: person.id, endDate: future }),
    ).rejects.toThrow(/in the future/)

    const [untouched] = await db.select().from(employees).where(eq(employees.id, person.id))
    expect(untouched.endDate).toBeNull()
    expect(untouched.isActive).toBe(true)
  })

  it('refuses a departure before the person started', async () => {
    const person = await createEmployee(fixture.ctx, {
      name: 'Cleo Mbeki',
      startDate: '2026-02-02',
    })

    await expect(
      recordEmployment(fixture.ctx, { employeeId: person.id, endDate: '2026-01-05' }),
    ).rejects.toThrow(/started on 2026-02-02/)
  })

  it('puts somebody back, because a retirement with no way back is Phase 206’s defect', async () => {
    const person = await createEmployee(fixture.ctx, { name: 'Tomas Oyelaran' })

    await recordEmployment(fixture.ctx, { employeeId: person.id, endDate: '2026-06-30' })
    const back = await recordEmployment(fixture.ctx, { employeeId: person.id, endDate: null })

    expect(back.endDate).toBeNull()
    expect(back.isActive).toBe(true)
    // One function and one vocabulary, not a second action (Phase 70).
    expect(readFileSync('src/modules/payroll/service.ts', 'utf8')).not.toContain(
      'export async function reinstateEmployee',
    )
  })

  it('refuses a payslip for somebody who left before the period opened', async () => {
    /*
      The check ADR 0208 said was missing. It was — and it could not have been
      written, because until this phase no end date could be recorded and the
      guard would have read an always-null column.
    */
    const person = await createEmployee(fixture.ctx, { name: 'Halvard Reiss' })
    await recordEmployment(fixture.ctx, { employeeId: person.id, endDate: '2026-04-30' })

    await expect(
      createPayrollRun(fixture.ctx, {
        frequency: 'monthly',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        payDate: '2026-06-30',
        payslips: [payslipFor(person.id)],
      }),
    ).rejects.toThrow(/left on 2026-04-30, before this period began on 2026-06-01/)
  })

  it('pays the last payslip of somebody who left mid-period', async () => {
    /**
     * The direction that matters more than the refusal.
     *
     * `createPayrollRun` reads the **unnarrowed** list deliberately and the
     * guard is on the date rather than the flag, because a person who left on
     * the 14th is owed the run that covers the 14th. Filtering on `isActive`
     * here would have refused the one payroll run that matters most, and it
     * would have looked like tightening a check.
     */
    const person = await createEmployee(fixture.ctx, { name: 'Marguerite Sol' })
    await recordEmployment(fixture.ctx, { employeeId: person.id, endDate: '2026-06-14' })

    const run = await createPayrollRun(fixture.ctx, {
      frequency: 'monthly',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      payDate: '2026-06-30',
      payslips: [payslipFor(person.id)],
    })

    expect(run.totals.grossPayCents).toBe(140_000)
  })
})

describe('the refusal that could never fire', () => {
  it('shows a message the application had never been able to say', async () => {
    /**
     * `book` has held this since Phase 3:
     *
     * ```ts
     * if (!practitioner.isActive) {
     *   throw new AppointmentError(`${practitioner.name} is no longer taking appointments.`)
     * }
     * ```
     *
     * The column defaults to `true` and had no writer, so the branch was
     * unreachable and the sentence had never reached anybody. A refusal nothing
     * can trigger is worse than a missing one, because reading the booking path
     * tells you a stood-down practitioner cannot be booked.
     */
    const salon = await createCompanyFixture({ name: 'Fenwick Row', industry: 'personal_care' })
    await setModuleEnabled(salon.ctx, 'appointments', true)

    const person = await addPractitioner(salon.ctx, { name: 'Noor Abadi', commissionBp: 4_000 })

    const stood = await setPractitionerActive(salon.ctx, {
      practitionerId: person.id,
      isActive: false,
    })
    expect(stood.isActive).toBe(false)

    await expect(
      book(salon.ctx, {
        practitionerId: person.id,
        startsAt: new Date(Date.UTC(2026, 5, 2, 9)),
        endsAt: new Date(Date.UTC(2026, 5, 2, 10)),
      }),
    ).rejects.toThrow(/Noor Abadi is no longer taking appointments/)

    // And back, in the same phase (Phase 206).
    await setPractitionerActive(salon.ctx, { practitionerId: person.id, isActive: true })
    const booked = await book(salon.ctx, {
      practitionerId: person.id,
      startsAt: new Date(Date.UTC(2026, 5, 2, 9)),
      endsAt: new Date(Date.UTC(2026, 5, 2, 10)),
    })
    expect(booked.id).toBeTruthy()
  })

  it('leaves the diary alone, because each booking is a promise to a client', async () => {
    const salon = await createCompanyFixture({ name: 'Brough & Vane', industry: 'personal_care' })
    await setModuleEnabled(salon.ctx, 'appointments', true)

    const person = await addPractitioner(salon.ctx, { name: 'Ilse Brandt', commissionBp: 5_000 })
    const appointment = await book(salon.ctx, {
      practitionerId: person.id,
      startsAt: new Date(Date.UTC(2026, 5, 9, 11)),
      endsAt: new Date(Date.UTC(2026, 5, 9, 12)),
    })

    await setPractitionerActive(salon.ctx, { practitionerId: person.id, isActive: false })

    // Still in the diary, and still hers.
    const [stored] = await db
      .select()
      .from(practitioners)
      .where(eq(practitioners.id, person.id))
    expect(stored.isActive).toBe(false)
    expect(appointment.id).toBeTruthy()

    // The register keeps her; it is the offer that narrows.
    expect(await listPractitioners(salon.ctx)).toHaveLength(1)
  })
})

describe('retiring a tax code', () => {
  it('stops it being offered without touching what it has already priced', async () => {
    /*
      Phase 209 built the composer's picker, passed `{ activeOnly: true }`, and
      recorded in the comment beside the call that the flag was inert. This is
      that comment coming out.
    */
    const code = await createTaxCode(fixture.ctx, {
      code: 'CITY',
      name: 'City sales tax',
      jurisdiction: 'City',
      rateBp: 825,
    })

    expect(await listTaxCodes(fixture.ctx, { activeOnly: true })).toHaveLength(1)

    const retired = await setTaxCodeActive(fixture.ctx, { taxCodeId: code.id, isActive: false })
    expect(retired.isActive).toBe(false)

    // Not offered.
    expect(await listTaxCodes(fixture.ctx, { activeOnly: true })).toEqual([])
    // Still on the company's list, because the return still reports it.
    expect(await listTaxCodes(fixture.ctx)).toHaveLength(1)

    /*
      And still priceable, which is the claim that makes retiring safe: a line
      already raised under this code carries the `rate_bp` it was priced at, so
      last quarter's return cannot move because this quarter's list did
      (ADR 0021).
    */
    const lines = await taxLinesFor(fixture.ctx, [{ amountCents: 10_000, taxCodeId: code.id }])
    expect(lines).toEqual([{ taxCodeId: code.id, taxableCents: 10_000, exemptCents: 0 }])

    const [stored] = await db.select().from(taxCodes).where(eq(taxCodes.id, code.id))
    expect(stored.rateBp).toBe(825)
  })

  it('leaves effectiveTo without a writer on purpose, and says so', () => {
    /*
      Retiring a code and superseding a rate are different acts. The second
      needs the successor to exist and `priceDocumentTax` to choose between
      them by date, and nothing does that — so `effective_to` keeps no writer
      and is a declared finding rather than half a meaning written from this
      control (Phase 185).
    */
    expect(
      COLUMN_WRITERS.find(
        (row) => row.table === 'tax_codes' && row.columns.includes('effectiveTo'),
      )?.verdict,
    ).toBe('unwritable')

    expect(applicationSource()).not.toContain('effectiveTo:')
  })
})

describe('the boxes that threw your typing away', () => {
  it('saves the second address line and the country the letterhead prints', async () => {
    /**
     * The two columns this register was created for.
     *
     * Phase 201's own docstring cites them: the narrow check written for
     * `description` *"named two more on its first run, and both were worse:
     * `letterhead.ts` reads `addressLine2` and `country` and puts them on every
     * document a client sees"*. Both got a field on the form. Neither got a
     * place to land, and the register that was built because of them has never
     * reported them, because `getProfile` is a projectionless select.
     */
    await saveProfile(fixture.ctx, {
      legalName: 'Harkness Plant Hire Ltd',
      addressLine1: 'Dock Road',
      addressLine2: 'Shed 4',
      city: 'Garston',
      postalCode: 'L19 2JX',
      country: 'United Kingdom',
      description: 'Tracked excavators and attachments, hired by the day.',
    })

    const profile = await getProfile(fixture.ctx)

    expect(profile?.addressLine2).toBe('Shed 4')
    expect(profile?.country).toBe('United Kingdom')
    expect(profile?.description).toContain('Tracked excavators')

    // And on the envelope, which is where a client sees them.
    expect(addressLines(profile)).toEqual([
      'Dock Road',
      'Shed 4',
      'Garston L19 2JX',
      'United Kingdom',
    ])
  })

  it('holds the whole chain, not just the form the tripwire checks', () => {
    /**
     * Phase 200 left a tripwire asserting that `PROFILE_FIELDS` covers the
     * profile's text columns, and it **passed throughout** — a form is one of
     * the three places a field has to exist. The boundary between them is
     * where the values went: a zod object strips what it does not declare, so
     * `profileSchema.parse` dropped three keys silently and the action
     * reported success.
     *
     * So this asserts the chain. Every field on the form is a key the action
     * accepts and a property the service's input type has, which is the check
     * that could not have gone quiet.
     */
    const workspace = readFileSync('src/app/studio/studio-workspace.tsx', 'utf8')
    const action = readFileSync('src/app/actions/studio.ts', 'utf8')
    const service = readFileSync('src/modules/studio/service.ts', 'utf8')

    const list = workspace.slice(
      workspace.indexOf('const PROFILE_FIELDS'),
      workspace.indexOf('function ProfileTab'),
    )
    const fields = [...list.matchAll(/key: '(\w+)'/g)].map((m) => m[1])
    expect(fields).toHaveLength(16)

    const schema = action.slice(
      action.indexOf('const profileSchema'),
      action.indexOf('export async function saveProfileAction'),
    )
    const input = service.slice(
      service.indexOf('export type ProfileInput'),
      service.indexOf('/** The profile, or null'),
    )

    for (const field of fields) {
      expect(schema, `${field} is on the form and not in profileSchema`).toMatch(
        new RegExp(String.raw`^\s+${field}: z\.`, 'm'),
      )
      expect(input, `${field} is on the form and not in ProfileInput`).toMatch(
        new RegExp(String.raw`^\s+${field}\?:`, 'm'),
      )
    }

    // The three that were missing, named so the loop above cannot pass by
    // failing to find any fields at all.
    for (const field of ['description', 'addressLine2', 'country']) {
      expect(fields).toContain(field)
    }
  })

  it('stops excusing credentials with an editor that does not exist', () => {
    /**
     * `tests/a-voice-to-adapt-to.test.ts` excluded `credentials` from its form
     * check as *"a structured list with its own editor and its own add/remove
     * controls"*. There is no such editor: nothing writes the column and
     * nothing reads it, and `modules/studio/team.ts` cites it as the reason
     * §15's certifications are covered.
     *
     * An exclusion that **excuses** a site is worse than one that misses it
     * (ADR 0134) — in the test that cites ADR 0134. It stays excluded from that
     * check, because a jsonb list of licences is not a text box; what changed is
     * that the reason now points at the register that holds it as a finding, so
     * the claim is tested somewhere instead of asserted in a comment.
     */
    const earlier = readFileSync('tests/a-voice-to-adapt-to.test.ts', 'utf8')

    expect(earlier).not.toContain('A structured list with its own editor')
    expect(earlier).toContain('`COLUMN_WRITERS` holds this one with the verdict `unwritable`')

    expect(
      COLUMN_WRITERS.find(
        (row) => row.table === 'company_profiles' && row.columns.includes('credentials'),
      )?.verdict,
    ).toBe('unwritable')
  })
})

describe('the screens that got the controls', () => {
  it('puts a leaving date, a retire and a stand-down where the register already is', () => {
    /*
      Source assertions, because no test calls a server action — they need a
      session. What is checked is that each writer is reachable from the screen
      that lists the records, rather than existing in the module only, which is
      the gap Phase 209 found between `listTaxCodes` and anything that could
      hand it a line.
    */
    const roster = readFileSync('src/app/payroll/people/roster.tsx', 'utf8')
    const codes = readFileSync('src/app/payroll/sales-tax/codes.tsx', 'utf8')
    const board = readFileSync('src/app/appointments/board.tsx', 'utf8')
    const actions = readFileSync('src/app/actions/payroll.ts', 'utf8')

    expect(roster).toContain('recordEmploymentAction')
    expect(roster).toContain('Record leaving')
    expect(roster).toContain('aria-label={`Leaving date for ${person.name}`}')
    // The server's today, so the refusal and the offer agree on the date.
    expect(readFileSync('src/app/payroll/people/page.tsx', 'utf8')).toContain('today={')

    expect(codes).toContain('setTaxCodeActiveAction')
    expect(codes).toContain("{entry.isActive ? 'Retire' : 'Offer again'}")

    expect(board).toContain('setPractitionerActiveAction')
    expect(board).toContain('stand down')

    /*
      The invoice composer's picker is revalidated too. It is the only reader of
      `tax_codes.is_active`, so a retired code still being offered until the
      next full load would be the inert flag with an extra step.
    */
    expect(actions).toContain("return run(['/payroll/sales-tax', '/accounting/invoices']")
  })

  it('demonstrates all five writers in the seed, on the paths the screens take', () => {
    /*
      Phase 209's lesson. The tax code nothing could reach survived forty
      phases longer than its sibling because the demo wrote the table through
      `createInvoice`'s own API, so every audit of the feature saw it working.
      A seed that exercises a path the application does not have is how a defect
      hides, so these go through the same functions the screens call.
    */
    const seed = readFileSync('src/db/seed.ts', 'utf8')

    expect(seed).toContain('await recordEmployment(ctx, { employeeId: priya.id')
    expect(seed).toContain('await setTaxCodeActive(ctx, { taxCodeId: cityTaxOld.id')
    expect(seed).toContain('await setPractitionerActive(salonCtx, { practitionerId: nina.id')
    expect(seed).toContain("addressLine2: 'Unit B, Mill Yard'")
    expect(seed).toContain("country: 'United States'")
  })
})
