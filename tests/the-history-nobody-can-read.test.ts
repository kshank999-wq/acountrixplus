import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { historyFor } from '@/modules/audit'
import {
  permissionToRead,
  permissionsToRead,
  withheldEntityTypes,
} from '@/modules/audit/visibility'
import { setJobBudget } from '@/modules/jobs/budgets'
import { createCostCode } from '@/modules/jobs/cost-codes'
import { setJobStatus } from '@/modules/jobs/lifecycle'
import {
  PERMISSIONS,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@/modules/permissions'
import {
  auditWriteSites,
  blindProducers,
  writtenEntityTypes,
} from '@/modules/source/audit-readers'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * The history nobody can read (Phase 213).
 *
 * ADR 0212 nominated six job-costing entity types that write audit events and
 * are not placed in the audit log's readable-types register, with one
 * instruction: measure *"which roles can produce each of those events, and
 * whether they can read them"* first.
 *
 * The measurement did not confirm the nomination. It replaced it.
 *
 * - **`sov` writes no audit events at all.** The schedule-of-values act files
 *   its event under `project`.
 * - **`project` is a second name for the table `job` was placed under.** Three
 *   acts write a job's history and all three carry `projects.id`; two of them
 *   said `project` and one said `job`. So Phase 212's placement — whose prose
 *   says a job "has a history for the first time" — reached the act about
 *   status and neither of the two about money.
 * - **Six was not the number.** Across every write site in `src/`, twenty
 *   entity types had a role that could cause an event and never read it, in six
 *   families. The nomination saw one of them, and saw it wrong.
 *
 * What this phase builds is the thing the register has never had: a scan that
 * asks it the question it exists to answer. `READABLE_BY` says who may read a
 * type's history; nobody had ever asked whether that includes the person who
 * *caused* the entry. Phase 78 wrote the sentence — *an audit entry the person
 * who made the correction cannot see is not much of an audit trail* — and then
 * it stayed prose for a hundred and thirty-five phases.
 */

let fixture: Fixture & { job: { id: string } }

beforeEach(async () => {
  const company = await createCompanyFixture({ industry: 'construction' })
  const [job] = await db
    .insert(projects)
    .values({
      companyId: company.companyId,
      code: 'JOB-2200',
      name: 'Eastgate Fit-Out',
      contractValueCents: 9_000_000,
      startDate: '2026-02-02',
    })
    .returning()

  fixture = { ...company, job }
})

function holds(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission)
}

/** Everyone who can open the whole feed, which is who a placement takes from. */
const AUDIT_VIEWERS = ROLE_NAMES.filter((role) => holds(role, 'audit:view'))

// --- The falsifier ---------------------------------------------------------

describe('the question the register was never asked', () => {
  /**
   * The phase in one line.
   *
   * Not "every type is placed" — most types should not be. 93 entity types are
   * written and 43 are placed, and the 50 that are not include `user`,
   * `device` and `push_subscription`, which are written by paths with no
   * permission gate at all. A count of unplaced types driven to zero would be
   * ADR 0134's shape: a number that teaches nobody anything and excuses the
   * sites it covers.
   *
   * The property is about a person instead. Nobody writes a record of their own
   * work into a drawer they are not allowed to open.
   */
  it('leaves no role able to cause an event it can never read', () => {
    expect(blindProducers()).toEqual([])
  })

  /**
   * An empty answer from an empty scan would say exactly the same thing, which
   * is the failure mode every scan in this codebase has had at least once.
   */
  it('scans enough to be able to fail', () => {
    const sites = auditWriteSites()

    expect(sites.length).toBeGreaterThan(250)
    expect(writtenEntityTypes(sites).length).toBeGreaterThan(90)
    expect(sites.filter((site) => site.gates.length > 0).length).toBeGreaterThan(200)
  })

  /**
   * Why the property can be true without placing everything.
   *
   * A public token, a background sweep and a path gated somewhere other than
   * the function that writes the event all produce a site with no
   * `requirePermission` — and a site with no gate names no role, so it blinds
   * nobody. That is the line that separates this from a quota, and it is worth
   * pinning because deleting it would turn the test green by making it empty.
   */
  it('counts an ungated act as blinding nobody', () => {
    const sites = auditWriteSites()
    const ungated = sites.filter((site) => site.gates.length === 0)

    expect(ungated.length).toBeGreaterThan(20)

    // `user` is the clearest case: password resets and email changes are
    // written by paths the actor reaches without any permission at all, so the
    // type is correctly left at `audit:view`.
    expect(permissionToRead('user')).toBe('audit:view')
    expect(ungated.some((site) => site.entityType === 'user')).toBe(true)
    expect(blindProducers(sites).some((row) => row.entityType === 'user')).toBe(false)
  })

  /**
   * The false finding the first version of this scan produced, kept because it
   * is a wrong reading of the permission model rather than a parsing slip.
   *
   * That version took the **nearest preceding** `requirePermission` — one
   * permission, the last before the write — and reported twenty-one findings
   * where there are twenty. `setVendorOrganization` requires two:
   * `accounting:journal` and then `crm:view`. Sequential calls are a
   * conjunction, so the act belongs to whoever holds both, which is `owner`
   * alone. Read as a `crm:view` act it appeared to belong to four more roles,
   * none of whom can reach the code, and `vendor` acquired a defect that cannot
   * happen.
   *
   * Pinned on the arithmetic rather than on the outcome: the roles holding the
   * last gate really are more than the roles holding all of them, so a scan
   * that went back to one permission would go green here and wrong elsewhere.
   */
  it('treats a function’s permissions as all-of, not the last one', () => {
    const sites = auditWriteSites()
    const linking = sites.find((site) => site.symbol === 'setVendorOrganization')

    expect(linking?.gates).toEqual(['accounting:journal', 'crm:view'])

    const byLastGate = ROLE_NAMES.filter((role) => holds(role, 'crm:view'))
    const byEveryGate = ROLE_NAMES.filter((role) =>
      linking!.gates.every((gate) => holds(role, gate)),
    )

    expect(byEveryGate).toEqual(['owner'])
    expect(byLastGate.length).toBeGreaterThan(byEveryGate.length)
    expect(blindProducers(sites).some((row) => row.entityType === 'vendor')).toBe(false)
  })

  /**
   * And the other half, which is ADR 0134's: a window of lines "leaked past a
   * function boundary and excused a real defect", so gates are read from the
   * enclosing function and the symbol it was attributed to must exist in the
   * file the scan claims to have read it from — the Phase 116 device, both
   * directions.
   */
  it('attributes every site to a function that is really there', () => {
    const sites = auditWriteSites()

    for (const site of sites) {
      const source = readFileSync(site.file, 'utf8')
      if (site.symbol === '(top level)') continue

      // The declaration the site was attributed to really is in that file,
      // which is the other half of the Phase 116 device: a scan that reports a
      // symbol must be checkable against the file it claims to have read.
      expect(
        new RegExp(`^(?:export )?(?:async )?function ${site.symbol}\\(`, 'm').test(source),
        `${site.file}:${site.symbol}`,
      ).toBe(true)
    }
  })

  /** Every gate the scan reports is a real permission, not a parse artefact. */
  it('reports gates that exist', () => {
    for (const site of auditWriteSites()) {
      for (const gate of site.gates) {
        expect(PERMISSIONS, `${site.file}:${site.symbol}`).toContain(gate)
      }
    }
  })
})

// --- What the nomination said ----------------------------------------------

describe('the nomination, measured rather than inherited', () => {
  /**
   * ADR 0212 named `sov` as one of six types writing unreadable events. No act
   * anywhere writes that type. The schedule of values files under the job.
   */
  it('finds no type called sov, because none was ever written', () => {
    expect(writtenEntityTypes()).not.toContain('sov')
  })

  /**
   * And `progress_billing`, which the nomination also named, never needed
   * placing — for a reason only the all-of rule shows. Both its acts require
   * `jobs:manage` **and** `accounting:journal`, and a bookkeeper holds the
   * first without the second, so the role the nomination was worried about
   * cannot raise a progress billing at all. Everyone who can is already an
   * `audit:view` holder.
   *
   * Placing it would have widened nothing and narrowed nothing: a correction
   * with nobody on either side of it, which is what a list assembled from
   * family resemblance produces.
   */
  it('finds progress_billing had no blind producer to begin with', () => {
    const sites = auditWriteSites().filter((site) => site.entityType === 'progress_billing')

    expect(sites.length).toBeGreaterThan(0)
    for (const site of sites) {
      expect(site.gates).toEqual(['jobs:manage', 'accounting:journal'])

      for (const role of ROLE_NAMES) {
        const produces = site.gates.every((gate) => holds(role, gate))
        if (produces) expect(holds(role, 'audit:view'), role).toBe(true)
      }
    }

    expect(holds('bookkeeper', 'jobs:manage')).toBe(true)
    expect(holds('bookkeeper', 'accounting:journal')).toBe(false)
    expect(permissionToRead('progress_billing')).toBe('audit:view')
  })

  /**
   * Two of six wrong, and the two the nomination could not see were the
   * expensive ones: a name it did not know about, and a scale off by more than
   * a factor of three. Phase 164's rule, paying for itself a fourth time.
   */
  it('finds six families rather than one', () => {
    const families = new Set(
      ['cost_code', 'change_order', 'subcontractor', 'compliance_document'].map((type) =>
        permissionToRead(type),
      ),
    )
    expect([...families]).toEqual(['jobs:view'])

    // The five the nomination never reached.
    expect(permissionToRead('bank_connection')).toBe('bookkeeping:view')
    expect(permissionToRead('reconciliation')).toBe('reconciliation:view')
    expect(permissionToRead('campaign')).toBe('marketing:view')
    expect(permissionToRead('communication')).toBe('crm:view')
    expect(permissionToRead('ai_suggestion')).toBe('ai:use')
  })
})

// --- One record, two names -------------------------------------------------

describe('the two names one job answered to', () => {
  /**
   * Phase 70's rule — one vocabulary for one correction — applied to the name a
   * record is filed under rather than to the words on a button.
   */
  it('files every act about a job under one type', () => {
    const sites = auditWriteSites().filter((site) => site.file.includes('src/modules/jobs/'))
    const types = [...new Set(sites.map((site) => site.entityType))]

    expect(types).toContain('job')
    expect(types).not.toContain('project')
    expect(writtenEntityTypes()).not.toContain('project')
  })

  /**
   * And the rows written before anybody noticed.
   *
   * The writers saying `job` would leave a job's history split in two, with the
   * older half permanently unreadable by the person who caused it — honouring
   * an audit row's immutability by hiding what it recorded. What the migration
   * moves is the drawer, not the contents.
   */
  it('moves the events already filed under the old name', () => {
    const migration = readFileSync(
      'drizzle/0105_phase213_the_history_nobody_can_read.sql',
      'utf8',
    )

    expect(migration).toContain(
      "UPDATE audit_events SET entity_type = 'job' WHERE entity_type = 'project'",
    )
    expect(migration).toContain('one vocabulary for one record')
  })

  /**
   * The whole phase, end to end, on the role it was built for.
   *
   * A bookkeeper holds `jobs:manage` and not `audit:view`. Before this phase
   * they could set a budget and then read nothing about having done it; the
   * status change Phase 212 added was readable and the two acts about money
   * were not.
   */
  it('lets the bookkeeper who set the budget read that they set it', async () => {
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')
    expect(holds('bookkeeper', 'audit:view')).toBe(false)

    const code = await createCostCode(bookkeeper, { code: '03-300', name: 'Concrete' })
    await setJobBudget(bookkeeper, fixture.job.id, [
      { costCodeId: code.id, originalAmountCents: 2_500_000 },
    ])
    await setJobStatus(bookkeeper, { projectId: fixture.job.id, status: 'on_hold' })

    const history = await historyFor(bookkeeper, 'job', fixture.job.id)
    const actions = history.map((row) => row.action)

    expect(actions).toContain('budget.set')
    expect(actions).toContain('job.status')
  })
})

// --- A record with two doors -----------------------------------------------

describe('a record that can be opened two ways', () => {
  /**
   * The shape change, and why it was forced rather than chosen.
   *
   * `createCustomer` is gated on `crm:manage`, held by `manager` and `sales`,
   * neither of whom holds `accounting:view`. One permission per type meant
   * either the accountant who reads the receivables ledger or the salesperson
   * who creates the customer, and never both.
   */
  it('names every permission that opens a customer', () => {
    expect(permissionsToRead('customer')).toEqual(['accounting:view', 'crm:view'])
    expect(permissionsToRead('proposal')).toEqual(['crm:view', 'accounting:view'])
  })

  /** Phase 47: a refusal names one actionable thing, so the primary is first. */
  it('still answers with one permission for a refusal to name', () => {
    expect(permissionToRead('customer')).toBe('accounting:view')
    expect(permissionToRead('proposal')).toBe('crm:view')
    expect(permissionToRead('job')).toBe('jobs:view')
  })

  it('withholds a two-door record only from a reader holding neither key', () => {
    const crmOnly = withheldEntityTypes((permission) => permission === 'crm:view')
    const booksOnly = withheldEntityTypes((permission) => permission === 'accounting:view')
    const neither = withheldEntityTypes((permission) => permission === 'payroll:view')

    expect(crmOnly).not.toContain('customer')
    expect(booksOnly).not.toContain('customer')
    expect(neither).toContain('customer')

    expect(crmOnly).not.toContain('proposal')
    expect(booksOnly).not.toContain('proposal')
    expect(neither).toContain('proposal')
  })

  /**
   * Two, and only two. A list where a single permission would do is a way of
   * not deciding, and the register's whole value is that each entry decided.
   */
  it('keeps every other entry down to one permission', () => {
    const multiple = writtenEntityTypes()
      .concat(['customer', 'proposal'])
      .filter((type) => permissionsToRead(type).length > 1)

    expect([...new Set(multiple)].sort()).toEqual(['customer', 'proposal'])
  })

  /**
   * The door really opens. A salesperson may read the history of a customer
   * they corrected — which, before this phase, was the one thing the register
   * guaranteed they could not do.
   */
  it('lets a salesperson read a customer’s history', async () => {
    const sales = await addUserWithRole(fixture, 'sales')
    expect(holds('sales', 'accounting:view')).toBe(false)
    expect(holds('sales', 'audit:view')).toBe(false)

    await expect(historyFor(sales, 'customer', fixture.job.id)).resolves.toEqual([])
  })
})

// --- The half that takes something away ------------------------------------

describe('what a placement takes away', () => {
  /**
   * ADR 0212's one correct caveat: `withheldEntityTypes` is a `NOT IN` handed
   * to the feed, so an unplaced type is visible to every holder of
   * `audit:view`, and placing it hands the type to the people who may read that
   * kind of record *instead*. Measured per type, as the ADR insisted, rather
   * than assumed from `job`'s.
   */
  it('takes nothing from anybody for most of this phase’s placements', () => {
    const givesOnly = [
      'bank_connection',
      'import_run',
      'reconciliation',
      'ai_suggestion',
      'cost_code',
      'change_order',
      'subcontractor',
      'compliance_document',
      'vehicle',
      'repair_order',
    ]

    for (const type of givesOnly) {
      for (const role of AUDIT_VIEWERS) {
        expect(
          permissionsToRead(type).some((permission) => holds(role, permission)),
          `${role} lost ${type}`,
        ).toBe(true)
      }
    }
  })

  /**
   * And the five that do take something, each deliberate and each the same
   * argument Phase 72 made about a manager and the payroll: *the permission
   * that guards a record guards the events about it too.* A manager may not
   * open a customer statement or a pay run, and the feed was handing them the
   * history of both.
   */
  it('names exactly who loses what, and why it is the right direction', () => {
    const losses = new Map<string, Role[]>()
    for (const type of writtenEntityTypes()) {
      const lost = AUDIT_VIEWERS.filter(
        (role) => !permissionsToRead(type).some((permission) => holds(role, permission)),
      )
      if (lost.length > 0) losses.set(type, lost)
    }

    // Phase 213's own narrowing, in full.
    expect(losses.get('customer_statement')).toEqual(['manager'])
    expect(losses.get('pay_run')).toEqual(['manager'])
    expect(losses.get('campaign')).toEqual(['accountant'])
    expect(losses.get('segment')).toEqual(['accountant'])
    expect(losses.get('suppression')).toEqual(['accountant'])
    expect(losses.get('communication')).toEqual(['accountant'])
    expect(losses.get('task')).toEqual(['accountant'])

    // The two entries that changed shape take nothing from anybody — which is
    // the argument for the shape rather than for picking the other permission.
    expect(losses.has('customer')).toBe(false)
    expect(losses.has('proposal')).toBe(false)

    // Nobody loses an owner's view of anything, ever.
    for (const lost of losses.values()) expect(lost).not.toContain('owner')
  })
})

// --- The register itself ---------------------------------------------------

describe('the register after the phase', () => {
  it('places forty-four types and leaves the rest correctly silent', () => {
    const placed = writtenEntityTypes().filter(
      (type) => permissionToRead(type) !== 'audit:view',
    )

    // `customer` and the rest are all written, so the written set covers the
    // register; a type placed but never written would be prose nothing reads.
    //
    // Forty-four since Phase 214 placed `asset`, and the way it got there is
    // the point. This phase's property found it — the same `blindProducers()`
    // this file asserts is empty — once the scan could read a permission
    // computed from the record's own kind. `linkAsset` gates on
    // `subject.manage`, every asset subject manages under `marketing:manage`,
    // and `marketing` holds no `audit:view`: a marketer could attach and detach
    // an asset and read the history of neither. The forty-three above were found
    // by asking the register a question it had never been asked; the
    // forty-fourth was found by fixing the reader that asked it.
    expect(placed.length).toBe(44)
    expect(writtenEntityTypes().length).toBe(93)
  })

  /**
   * Phase 179's shape, guarded: an entry naming a permission that does not
   * exist would read as a decision and behave as `audit:view`, because
   * `holds` would simply never be true for it.
   */
  it('names only permissions that exist', () => {
    for (const type of writtenEntityTypes()) {
      for (const permission of permissionsToRead(type)) {
        expect(PERMISSIONS, type).toContain(permission)
      }
    }
  })
})
