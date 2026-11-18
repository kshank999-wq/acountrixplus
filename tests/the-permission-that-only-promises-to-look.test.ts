import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customerStatements } from '@/db/schema'
import { createCompanyFixture, addUserWithRole } from './helpers'
import { PermissionError, ROLE_PERMISSIONS, type Permission, type Role } from '@/modules/permissions'
import {
  OPEN_ENDPOINTS,
  authorityOf,
  establishedBy,
  mislabelledGates,
  openEndpoint,
  openEndpointDefects,
  serverActions,
  ungatedActions,
  viewOnlyPermissions,
  viewOnlyRoles,
} from '@/modules/source/action-gates'
import { functionBody } from '@/modules/source/gate-forms'
import { runChases } from '@/modules/receivables/chase-run'
import { runStatements } from '@/modules/receivables/statement-run'
import { saveStatement } from '@/modules/receivables/statements'
import { createCustomer, createVendor } from '@/modules/receivables/service'
import { installDefaultCostCodes } from '@/modules/jobs/cost-codes'
import { RegistryError } from '@/modules/errors/registry'

/**
 * The permission that only promises to look (Phase 217).
 *
 * ADR 0216 nominated the page guard that guards nothing and proposed comparing
 * each action's gate to its page's. A page guard says who may look at a screen:
 * gating `runChases` on the `accounting:view` its page guards would have
 * satisfied that property and still let a read-only user send dunning letters.
 *
 * The question none of Phases 214–216 asks is whether a gate names the **right**
 * permission. `sendStatement` required `accounting:view` and emails a customer —
 * there is a gate, every caller reaches it, and it throws a `PermissionError`
 * naming its permission, so all three earlier questions answer yes.
 */

const holds = (role: Role, permission: Permission) =>
  (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission)

describe('the role that cannot change anything, sending mail', () => {
  /**
   * The defect as a customer met it: a letter from the company, signed by a
   * company that never authorised this person to send one.
   */
  it('refuses the whole statement run rather than completing it', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const reader = await addUserWithRole(fixture, 'readonly')

    // The page offering this guards `accounting:view`, which readonly holds, so
    // the screen admits them. The endpoint is what has to refuse.
    expect(holds('readonly', 'accounting:view')).toBe(true)
    expect(holds('readonly', 'accounting:journal')).toBe(false)

    await expect(runStatements(reader)).rejects.toThrow(PermissionError)

    // And nothing was saved on the way to the refusal. Before this phase the
    // run did not fail part-way: `saveStatement` and `sendStatement` both
    // settled for `accounting:view`, so it completed.
    const saved = await db
      .select({ id: customerStatements.id })
      .from(customerStatements)
      .where(eq(customerStatements.companyId, fixture.companyId))
    expect(saved).toEqual([])
  })

  /**
   * `runChases` was not ungated — `sendInvoice` requires `accounting:journal`.
   * The gate was reached inside the loop, through a catch written for a bad
   * address, so the refusal came back as `0 sent, 12 could not be sent` with the
   * permission error in the notes. Phase 47: "could not be sent" tells you to go
   * and check the addresses.
   */
  it('refuses the chase run instead of counting the refusal as a delivery failure', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const reader = await addUserWithRole(fixture, 'readonly')

    await expect(runChases(reader)).rejects.toThrow(PermissionError)

    const error = await runChases(reader).catch((caught: unknown) => caught)
    expect((error as PermissionError).message).toBe(
      'Missing required permission: accounting:journal',
    )
  })

  /**
   * The two early returns. Both sweeps returned before the loop when the policy
   * was off or nothing was due, so on most days no gate was reached at all and a
   * reader was told "Nothing was due today." Phase 216's finding one module over:
   * nothing due is an answer only if you were allowed to look.
   *
   * This fixture has chasing switched off, which is the default, so before this
   * phase it answered `{ enabled: false }` without consulting a permission.
   */
  it('refuses even when the policy is off and there is nothing to send', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const reader = await addUserWithRole(fixture, 'readonly')

    await expect(runChases(reader)).rejects.toThrow(PermissionError)
    await expect(runStatements(reader)).rejects.toThrow(PermissionError)

    // The owner still gets the straight answer, so the gate replaced nothing.
    const result = await runChases(fixture.ctx)
    expect(result.enabled).toBe(false)
    expect(result.sent).toBe(0)
  })

  /** Saving one statement, which is what the run does per customer. */
  it('refuses to save a statement behind a view permission', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const reader = await addUserWithRole(fixture, 'readonly')
    const customer = await createCustomer(fixture.ctx, {
      name: 'Harbour Freight Ltd',
      email: 'harbour@test.test',
    })

    await expect(
      saveStatement(reader, { customerId: customer.id, asOfDate: '2026-07-01' }),
    ).rejects.toThrow(PermissionError)
  })

  /**
   * `createVendor`'s own comment says "As on the customer side. See
   * `createCustomer` (Phase 47)." `createCustomer`, sixty lines above it in the
   * same file, requires `crm:manage`. This required `accounting:view`, so the
   * gap between the comment and the gate was exactly the gap between being
   * unable to create a customer and being able to create a supplier.
   */
  it('asks the same of a supplier as of a customer, which its comment already claimed', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const reader = await addUserWithRole(fixture, 'readonly')

    expect(holds('readonly', 'crm:manage')).toBe(false)
    await expect(createVendor(reader, { name: 'Cole Timber' })).rejects.toThrow(PermissionError)

    const source = readFileSync('src/modules/receivables/service.ts', 'utf8')
    expect(source).toMatch(/As on the customer side\. See `createCustomer`/)
  })

  /** The one act in all 329 with no permission anywhere in its chain. */
  it('asks for jobs:manage to install the cost-code library', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const reader = await addUserWithRole(fixture, 'readonly')

    // The page guards `jobs:view`, which readonly holds; `createCostCode`
    // requires `jobs:manage`, and this creates several at once.
    expect(holds('readonly', 'jobs:view')).toBe(true)
    expect(holds('readonly', 'jobs:manage')).toBe(false)

    await expect(installDefaultCostCodes(reader)).rejects.toThrow(PermissionError)
    expect(await installDefaultCostCodes(fixture.ctx)).toBeGreaterThan(0)
  })
})

describe('the question none of the last three phases asks', () => {
  /**
   * The property. Phase 214 asked whether there is a gate, Phase 215 whether the
   * refusal can say why, Phase 216 whether the caller established it. All three
   * are satisfied by `requirePermission(ctx, 'accounting:view')` on a function
   * that emails a customer.
   */
  it('leaves no act writing or sending behind a permission a reader holds', () => {
    expect(mislabelledGates()).toEqual([])
  })

  /**
   * The oracle is computed, not listed, which is Phase 216's arm 2 used as a
   * definition. Give `readonly` one `:manage` and this stops being true, which
   * is the point: the property's premise fails loudly rather than silently
   * admitting a role it was never written for.
   */
  it('derives the view-only roles from the permission table', () => {
    expect(viewOnlyRoles()).toEqual(['readonly'])

    const permissions = viewOnlyPermissions()
    expect([...permissions].sort()).toEqual([
      'accounting:view',
      'bookkeeping:view',
      'jobs:view',
      'reconciliation:view',
      'reports:view',
    ])

    // Every one of them is built from the word this phase is named for.
    for (const permission of permissions) expect(permission).toMatch(/:view$/)
  })

  /** The four acts the fix moved, each to what its own file already named. */
  it('takes each permission from the act’s own sibling rather than inventing one', () => {
    const cases: Array<[string, string, Permission]> = [
      ['src/modules/receivables/statement-send.ts', 'sendStatement', 'accounting:journal'],
      ['src/modules/payables/remittance-send.ts', 'sendRemittance', 'accounting:journal'],
      ['src/modules/exporter/service.ts', 'readinessFor', 'reports:financial'],
      ['src/modules/jobs/cost-codes.ts', 'installDefaultCostCodes', 'jobs:manage'],
    ]

    for (const [file, symbol, permission] of cases) {
      expect(establishedBy(file, symbol), `${symbol}`).toContain(permission)
    }

    // And the siblings that set each precedent still require it, so these are
    // agreements rather than coincidences.
    expect(establishedBy('src/modules/receivables/send.ts', 'sendInvoice')).toContain(
      'accounting:journal',
    )
    expect(establishedBy('src/modules/exporter/service.ts', 'exportForAccountant')).toContain(
      'reports:financial',
    )
    expect(establishedBy('src/modules/jobs/cost-codes.ts', 'createCostCode')).toContain(
      'jobs:manage',
    )
    expect(establishedBy('src/modules/receivables/service.ts', 'createCustomer')).toContain(
      'crm:manage',
    )
  })
})

describe('the register of endpoints that need no permission', () => {
  it('matches what the scan measures, in both directions', () => {
    expect(openEndpointDefects()).toEqual([])
  })

  it('counts 329 actions, of which 38 establish nothing', () => {
    expect(serverActions()).toHaveLength(329)
    expect(ungatedActions()).toHaveLength(38)
    expect(OPEN_ENDPOINTS).toHaveLength(38)
  })

  it('argues every entry from an authority that stands in for a role', () => {
    const categories = new Set(OPEN_ENDPOINTS.map((entry) => entry.category))
    expect([...categories].sort()).toEqual(['bootstrap', 'practice', 'pure', 'self', 'token'])

    for (const entry of OPEN_ENDPOINTS) {
      expect(entry.why.length, entry.action).toBeGreaterThan(60)
      expect(openEndpoint(entry.file, entry.action)).toBe(entry)
    }

    // The practice side is the largest group and the one with no `Permission` at
    // all behind it (Phase 214's ninth form).
    const practice = OPEN_ENDPOINTS.filter((entry) => entry.category === 'practice')
    expect(practice).toHaveLength(14)
  })

  it('refuses an endpoint nobody has declared, and names the remedy', () => {
    try {
      openEndpoint('jobs', 'somethingNewAction')
      throw new Error('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      const message = (error as RegistryError).message
      expect(message).toMatch(/no page guard upstream of it is a gate/)
      expect(message).toMatch(/permission its own module already names/)
    }
  })

  /** The three acts that left this register by being gated. */
  it('no longer holds the two sweeps or the cost-code library', () => {
    const keys = OPEN_ENDPOINTS.map((entry) => `${entry.file}::${entry.action}`)
    expect(keys).not.toContain('chasing::runChasesNowAction')
    expect(keys).not.toContain('statement-runs::runStatementsNowAction')
    expect(keys).not.toContain('jobs::installCostCodesAction')
  })
})

describe('the scan that was wrong five times', () => {
  /**
   * Cause one: reading only a function's own body. Each of these has its gate in
   * a private helper declared in the same file, and each was reported as ungated
   * before `establishedBy` followed same-file declarations.
   */
  it('finds a gate in a helper declared in the same file', () => {
    // `decide` requires `ai:use`.
    expect(establishedBy('src/modules/ai/suggestions.ts', 'rejectSuggestion')).toContain('ai:use')

    /*
      `loadOwnEditable` requires `users:manage` for somebody else's timesheet,
      and reading it takes `authorityOf` rather than `establishedBy` — which is
      the whole reason those are two functions. `establishedBy` answers "is it
      gated at all" and stops at the first set it finds, which for `updateTime`
      is its own `accounting:view`. Asserting against the wrong one of the pair
      was this file's own version of the mistake the pair exists to prevent.

      `submitTime` is absent on purpose: it never reaches this helper. Its
      authority is the `eq(timeEntries.userId, ctx.userId)` predicate, which the
      test below covers.
    */
    for (const symbol of ['updateTime', 'deleteTime']) {
      expect(authorityOf('src/modules/timebilling/service.ts', symbol), symbol).toContain(
        'users:manage',
      )
      expect(establishedBy('src/modules/timebilling/service.ts', symbol), symbol).toEqual([
        'accounting:view',
      ])
    }

    // `buildPlan` is declared in the action file itself.
    expect(establishedBy('src/app/actions/importing.ts', 'planImportAction').length).toBeGreaterThan(
      0,
    )
  })

  /**
   * Cause two, and the serious one: matching only `@/modules/...` imports. A
   * gate's commonest home is a sibling file in the same module, imported
   * relatively. Reading one form moved the ungated count from 47 to 39 and
   * cleared four acts that a draft of ADR 0217 named as defects.
   */
  it('follows a gate imported relatively from a sibling file', () => {
    const source = readFileSync('src/modules/ai/bookkeeping.ts', 'utf8')
    expect(source).toMatch(/from '\.\/retrieval'/)

    // `transactionContext` checks `bookkeeping:view` and lives next door.
    expect(establishedBy('src/modules/ai/bookkeeping.ts', 'suggestCategory')).toContain(
      'bookkeeping:view',
    )
    expect(establishedBy('src/app/actions/ai.ts', 'suggestCategoryAction')).toContain(
      'bookkeeping:view',
    )

    // And the one the scan accused and the code acquitted.
    expect(establishedBy('src/modules/marketing/audience.ts', 'segmentSummary')).toContain(
      'marketing:view',
    )
  })

  /**
   * Cause three, found while writing the falsifier rather than before it.
   * `submitTime` requires `accounting:view` and writes, and reaches no helper
   * that escalates — its authority is `eq(timeEntries.userId, ctx.userId)` in
   * the WHERE clause, so the only row it can touch is the caller's own draft.
   * Phase 214's `self` form in a predicate instead of an `if`.
   *
   * The arm matches the comparison and not any mention of `ctx.userId`, which
   * is ADR 0134's exclusion-that-excuses: nearly every write here stores
   * `createdBy: ctx.userId`, so the loose version would have excused all seven
   * acts this phase fixes.
   */
  it('reads identity in a predicate without excusing writes that merely stamp it', () => {
    const source = readFileSync('src/modules/timebilling/service.ts', 'utf8')
    expect(source).toMatch(/eq\(timeEntries\.userId, ctx\.userId\)/)

    // 14 self-scoped writes in src/modules, and not one of them among the seven.
    const sevenFixed = [
      ['src/modules/receivables/statements.ts', 'saveStatement'],
      ['src/modules/receivables/statement-send.ts', 'sendStatement'],
      ['src/modules/receivables/statement-send.ts', 'statementLinkFor'],
      ['src/modules/payables/remittance-send.ts', 'sendRemittance'],
      ['src/modules/payables/remittance-send.ts', 'remittanceLinkFor'],
      ['src/modules/payables/pay-runs.ts', 'adviseRun'],
      ['src/modules/receivables/service.ts', 'createVendor'],
    ] as const

    for (const [file, symbol] of sevenFixed) {
      const body = functionBody(file, symbol)
      expect(body, symbol).not.toBeNull()
      expect(/eq\(\s*\w+\.userId\s*,\s*ctx\.userId\s*\)/.test(body!), symbol).toBe(false)
    }
  })

  /**
   * Phase 214's figure, corrected. `src/app` holds eight `requirePermission`
   * calls in three files; the eleven that ADR 0214 reported counted three
   * `import { requirePermission } from …` lines. It changes no argument — gates
   * live in modules, and eight makes that case more strongly than eleven — but a
   * number cited as evidence has to be the number.
   */
  it('counts calls in src/app rather than occurrences of the word', () => {
    const files = [
      'src/app/actions/operations.ts',
      'src/app/actions/security.ts',
      'src/app/actions/inventory.ts',
    ]

    let calls = 0
    let imports = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      calls += [...source.matchAll(/requirePermission\(/g)].length
      imports += [...source.matchAll(/^import .*requirePermission/gm)].length
    }

    expect(calls).toBe(8)
    expect(imports).toBe(3)
    expect(calls + imports).toBe(11)
  })
})
