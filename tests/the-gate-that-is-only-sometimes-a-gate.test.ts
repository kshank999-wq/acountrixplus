import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  conditionalAt,
  statementAt,
  withoutComments,
} from '@/modules/source/enclosing'
import { functionBody } from '@/modules/source/gate-forms'
import {
  CONDITIONAL_GATES,
  conditionalGate,
  mayDemand,
  rolesSatisfying,
  serverActions,
  unexplainedConditionalGates,
  willDemand,
} from '@/modules/source/action-gates'
import { RegistryError } from '@/modules/errors/registry'
import { ROLE_PERMISSIONS } from '@/modules/permissions'
import { createOpportunity, createOrganization, changeStage } from '@/modules/crm/opportunities'
import { convertWonOpportunity } from '@/modules/crm/conversion'
import {
  createProposal,
  decideProposal,
  sendProposal,
  setBillingSchedule,
} from '@/modules/crm/proposals'
import { setModuleEnabled } from '@/modules/industry/modules'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * The gate that is only sometimes a gate (Phase 219).
 *
 * ADR 0218 nominated a register pinning each of the 73 flags to the act behind
 * its control, and guessed it at "73 entries or 180". Measured: **236**, of
 * which 230 would say the same thing. And the 107 references it could not place
 * are not unflagged — 35 are mounted behind a flag whose body is declared
 * elsewhere, more are called from handlers whose control is guarded. React
 * separates the call from the control by design, so lexical enclosure places a
 * reference only when the author wrote the call inline in the JSX.
 *
 * So this phase asks a property that reads no spans at all: *if even all of a
 * component's flags together admit somebody the act refuses, no arrangement of
 * them guards that control.* Over 236 pairs it leaves two, and both are one
 * thing — a check that applies on some paths and not others.
 */

describe('a statement, in a codebase with no semicolons', () => {
  const body = `{
  const lines = parsed.lines
    .map((line) => ({
      debit: line.debit.trim() ? parse(line.debit) : 0,
    }))
    .filter((line) => line.debit !== 0)

  const entry = await postManualEntry(actor, { lines })
}`

  it('folds continuation lines and stops at the statement that owns them', () => {
    const at = body.indexOf('postManualEntry')
    const statement = statementAt(body, at)

    expect(statement).toContain('const entry')
    // The ternary four lines up belongs to the statement above this one.
    expect(statement).not.toContain('?')
  })

  /**
   * Phase 121: the reading this replaced, applied to the same text, has to
   * disagree — otherwise the repair is untested.
   */
  it('disagrees with the reading that scanned back for a semicolon', () => {
    const at = body.indexOf('postManualEntry')
    const old = body.slice(0, at)

    // No semicolon anywhere, so the old scan-back never terminated and found
    // the `?` from an unrelated statement.
    expect(/\?[^;]*$/.test(old)).toBe(true)
    expect(conditionalAt(body, at)).toBe(false)
  })

  it('reads the four shapes a branch comes in', () => {
    const block = `{
  if (ready) {
    requirePermission(ctx, 'jobs:manage')
  }
  requirePermission(ctx, 'crm:manage')
}`
    expect(conditionalAt(block, block.indexOf("'jobs:manage'"))).toBe(true)
    expect(conditionalAt(block, block.indexOf("'crm:manage'"))).toBe(false)

    const braceless = `{
  if (userId !== ctx.userId) requirePermission(ctx, 'users:manage')
}`
    expect(conditionalAt(braceless, braceless.indexOf("'users:manage'"))).toBe(true)

    const ternary = `{
  const p = kind === 'marketing' ? can(ctx, 'marketing:manage') : false
}`
    expect(conditionalAt(ternary, ternary.indexOf("'marketing:manage'"))).toBe(true)

    const shortCircuit = `{
  const ok = enabled && can(ctx, 'tax:view')
}`
    expect(conditionalAt(shortCircuit, shortCircuit.indexOf("'tax:view'"))).toBe(true)
  })

  /**
   * The act the first reading libelled. `postManualEntry` gates on
   * `accounting:journal` on the first line of its body; the semicolon scan-back
   * called it conditional and put `postEntryAction` in the conditional-only
   * bucket, where it would have needed a register entry explaining a branch it
   * does not have.
   */
  it('does not call an unconditional gate conditional', () => {
    const body = withoutComments(functionBody('src/modules/ledger/journal.ts', 'postManualEntry')!)

    expect(conditionalAt(body, body.indexOf("'accounting:journal'"))).toBe(false)
    expect(willDemand('src/app/actions/accounting.ts', 'postEntryAction')).toContainEqual([
      'accounting:journal',
    ])
  })
})

describe('what an act will demand, and what it may', () => {
  /**
   * The case that split the function. `convertWonOpportunity` gates on
   * `crm:manage` at the top and reaches the other three only inside
   * `if (opts.createInvoice && winningProposal) { if (scheduled.length > 0) {`.
   */
  it('separates the gates on every path from the gates on some path', () => {
    const file = 'src/modules/crm/conversion.ts'

    expect(willDemand(file, 'convertWonOpportunity')).toEqual([['crm:manage']])
    expect(rolesSatisfying(willDemand(file, 'convertWonOpportunity'))).toEqual([
      'owner',
      'manager',
      'sales',
    ])

    const may = mayDemand(file, 'convertWonOpportunity').flat()
    expect(may).toContain('jobs:manage')
    expect(may).toContain('accounting:journal')
  })

  /**
   * And the correction to ADR 0218, which said `logTime` reaches `users:manage`
   * *"via `loadOwnEditable`, on a branch"*. The conclusion was right and the
   * mechanism was wrong: `loadOwnEditable` is not on `logTime`'s path at all.
   */
  it('finds the branch where it actually is', () => {
    const service = readFileSync('src/modules/timebilling/service.ts', 'utf8')
    const body = withoutComments(functionBody('src/modules/timebilling/service.ts', 'logTime')!)

    expect(body).not.toContain('loadOwnEditable')
    expect(service).toContain("if (userId !== ctx.userId) requirePermission(ctx, 'users:manage')")

    expect(willDemand('src/app/actions/timebilling.ts', 'logTimeAction')).toEqual([
      ['accounting:view'],
    ])
    expect(mayDemand('src/app/actions/timebilling.ts', 'logTimeAction').flat()).toContain(
      'users:manage',
    )
  })

  it('leaves an act whose checks are all unconditional exactly where it was', () => {
    for (const [file, symbol, expected] of [
      ['src/app/actions/drawers.ts', 'closeShiftAction', ['accounting:journal', 'accounting:view']],
      ['src/modules/receivables/send.ts', 'sendInvoice', ['accounting:journal']],
      ['src/app/actions/parties.ts', 'updateCustomerAction', ['crm:manage', 'crm:view']],
    ] as const) {
      expect(willDemand(file, symbol).flat().sort(), symbol).toEqual([...expected])
      expect(mayDemand(file, symbol).flat().sort(), symbol).toEqual([...expected])
    }
  })

  it('differs for a measured minority of the acts, not for most of them', () => {
    const differ = serverActions().filter((key) => {
      const [file, action] = key.split('::')
      const path = `src/app/actions/${file}.ts`
      return JSON.stringify(willDemand(path, action)) !== JSON.stringify(mayDemand(path, action))
    })

    expect(serverActions()).toHaveLength(329)
    expect(differ.length).toBeGreaterThan(10)
    expect(differ.length).toBeLessThan(60)
  })
})

describe('the acts whose only gate is conditional', () => {
  it('explains every one of them', () => {
    expect(unexplainedConditionalGates()).toEqual([])
  })

  it('is five, and each entry argues for itself', () => {
    expect(CONDITIONAL_GATES).toHaveLength(5)
    for (const gate of CONDITIONAL_GATES) {
      expect(gate.why.length, gate.action).toBeGreaterThan(80)
    }
  })

  /** Phase 47: the refusal names what to do about it. */
  it('refuses an act nobody has placed', () => {
    try {
      conditionalGate('jobs', 'somethingNewAction')
      throw new Error('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      const message = (error as RegistryError).message
      expect(message).toMatch(/indistinguishable/)
      expect(message).toMatch(/Say which branch carries the gate/)
    }
  })

  /**
   * The register must not be absorbing a scan error. Seventeen acts were in
   * this bucket before `statementAt` existed, and `postEntryAction` was one of
   * them — so it is named here as one that must stay out.
   */
  it('does not hold an act that has a gate on every path', () => {
    const named = CONDITIONAL_GATES.map((g) => `${g.file}::${g.action}`)

    expect(named).not.toContain('accounting::postEntryAction')
    expect(named).not.toContain('bookkeeping::createRuleAction')
    expect(named).not.toContain('marketing::createCampaignAction')
  })
})

describe('the screen, asked a question that reads no spans', () => {
  /**
   * The strictest guard a screen can be applying is the conjunction of all its
   * flags. If even that admits somebody the act refuses, no arrangement of them
   * guards the control — and no span is read, so a guard form this scan cannot
   * see is incapable of producing a finding here.
   */
  it('offers no control that every one of its flags together cannot guard', () => {
    const pages = execSync(
      `cd ${process.cwd()} && grep -rl "can(actor," src/app --include=*.tsx --include=*.ts`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')

    type Flag = { page: string; component: string; permission: string }
    const wired: Flag[] = []

    const resolve = (file: string, symbol: string): string | null => {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/import\s+(?:(\w+)|\{([^}]+)\})\s*from\s*'([^']+)'/g)) {
        const names = m[1]
          ? [m[1]]
          : m[2].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
        if (!names.includes(symbol)) continue
        const spec = m[3]
        let base: string | null = null
        if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`
        else if (spec.startsWith('.')) {
          const parts = file.split('/').slice(0, -1).concat(spec.split('/'))
          const stack: string[] = []
          for (const part of parts) {
            if (part === '.' || part === '') continue
            if (part === '..') stack.pop()
            else stack.push(part)
          }
          base = stack.join('/')
        }
        if (base === null) return null
        for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
          try {
            readFileSync(base + ext, 'utf8')
            return base + ext
          } catch {
            /* next */
          }
        }
        return null
      }
      return null
    }

    for (const page of pages) {
      const src = readFileSync(page, 'utf8')
      const direct: { prop: string; permission: string }[] = []
      for (const m of src.matchAll(/^\s*(\w+)=\{can\(actor, '([^']+)'\)\}/gm)) {
        direct.push({ prop: m[1], permission: m[2] })
      }
      for (const m of src.matchAll(/^\s*const (\w+) = can\(actor, '([^']+)'\)/gm)) {
        for (const use of src.matchAll(new RegExp(`^\\s*(\\w+)=\\{${m[1]}\\}`, 'gm'))) {
          direct.push({ prop: use[1], permission: m[2] })
        }
      }
      for (const flag of direct) {
        const at = src.search(new RegExp(`^\\s*${flag.prop}=\\{`, 'm'))
        if (at === -1) continue
        const before = [...src.slice(0, at).matchAll(/<([A-Z]\w*)/g)]
        const element = before.length ? before[before.length - 1][1] : null
        const component = element ? resolve(page, element) : null
        if (component) wired.push({ page, component, permission: flag.permission })
      }
    }

    expect(wired.length).toBeGreaterThanOrEqual(73)

    const roles = Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]
    const findings: string[] = []
    let pairs = 0

    for (const component of new Set(wired.map((w) => w.component))) {
      for (const page of new Set(
        wired.filter((w) => w.component === component).map((w) => w.page),
      )) {
        const flags = wired.filter((w) => w.component === component && w.page === page)
        const strictest = roles.filter((r) =>
          flags.every((f) => (ROLE_PERMISSIONS[r] as readonly string[]).includes(f.permission)),
        )
        const required = [...readFileSync(page, 'utf8').matchAll(/if \(!can\(actor, '([^']+)'\)/g)].map(
          (m) => m[1],
        )
        const admitted = roles.filter((r) =>
          required.every((p) => (ROLE_PERMISSIONS[r] as readonly string[]).includes(p)),
        )

        const src = readFileSync(component, 'utf8')
        for (const m of src.matchAll(
          /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'(@\/app\/actions\/[^']+)'/g,
        )) {
          const target = `src/app/actions/${m[2].slice('@/app/actions/'.length)}.ts`
          for (const raw of m[1].split(',')) {
            const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
            if (!name.endsWith('Action')) continue
            pairs += 1
            const gate = willDemand(target, name)
            if (gate.length === 0) continue
            const allowed = rolesSatisfying(gate)
            const stranded = strictest.filter(
              (r) => admitted.includes(r) && !allowed.includes(r),
            )
            if (stranded.length) {
              findings.push(`${page} :: ${name} strands ${stranded.join(', ')}`)
            }
          }
        }
      }
    }

    expect(pairs).toBeGreaterThan(200)
    expect(findings).toEqual([])
  })

  /**
   * And the two the `may` reading leaves, which are opposite to each other and
   * are why conditionality belongs to the **call**: `/crm` writes
   * `convertAction(id, true)`, so its branch is always taken; `/time` passes no
   * `userId`, so its branch can never fire from that screen.
   */
  it('reads the arguments the screens actually pass', () => {
    expect(readFileSync('src/app/crm/pipeline-board.tsx', 'utf8')).toContain(
      'await convertAction(id, true)',
    )

    const time = readFileSync('src/app/time/board.tsx', 'utf8')
    expect(time).toContain('logTimeAction({')
    expect(time.slice(time.indexOf('logTimeAction({'), time.indexOf('logTimeAction({') + 260)).not.toContain(
      'userId',
    )
  })
})

describe('half a conversion, and then a refusal', () => {
  let fixture: Fixture
  let opportunityId: string

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Harborview Builders' })
    const revenue = await fixture.account('4000')

    const organization = await createOrganization(fixture.ctx, { name: 'Harborview' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Workshop fit-out',
      expectedValueCents: 2_000_000,
    })
    opportunityId = opportunity.id

    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Fit-out proposal',
      items: [{ description: 'Fit-out', unitPriceCents: 2_000_000, chartAccountId: revenue.id }],
    })
    // Job costing on, because the schedule of values is a job-costing artifact
    // and `setScheduleOfValues` calls `requireModule`. Without it the schedule
    // is simply not written and `sovStageCount` is 0 — which would make the
    // owner's case below indistinguishable from the withheld one.
    await setModuleEnabled(fixture.ctx, 'job_costing', true)
    await setBillingSchedule(fixture.ctx, proposal.id, [
      { label: 'On signing', kind: 'deposit', percentBp: 2_500 },
      { label: 'Foundation poured', kind: 'milestone', percentBp: 2_500 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ])
    await sendProposal(fixture.ctx, proposal.id)
    await decideProposal(fixture.ctx, proposal.id, 'won')
    await changeStage(fixture.ctx, opportunityId, { stage: 'won' })
  })

  /**
   * The defect. `/crm` calls `convertAction(id, true)`, and the billing half
   * runs **outside** the transaction that creates the customer and the project.
   * So a salesperson got the client and the job committed, then
   * `Missing required permission: jobs:manage` — and "This opportunity was
   * already converted." on the retry.
   */
  it('gives a salesperson the client and the job rather than a refusal', async () => {
    const sales = await addUserWithRole(fixture, 'sales')

    const result = await convertWonOpportunity(sales, opportunityId, { createInvoice: true })

    expect(result.customerId).toBeTruthy()
    expect(result.projectId).toBeTruthy()
    expect(result.alreadyConverted).toBe(false)
  })

  /** And never lets the omission pass for nothing having been omitted (Phase 216). */
  it('says the billing half was not raised', async () => {
    const sales = await addUserWithRole(fixture, 'sales')

    const result = await convertWonOpportunity(sales, opportunityId, { createInvoice: true })

    expect(result.billingWithheld).toBe(true)
    expect(result.sovStageCount).toBe(0)
    expect(result.depositInvoiceId).toBeNull()
  })

  it('still raises both for somebody who may', async () => {
    const result = await convertWonOpportunity(fixture.ctx, opportunityId, { createInvoice: true })

    expect(result.billingWithheld).toBe(false)
    expect(result.sovStageCount).toBe(2)
    expect(result.depositInvoiceId).not.toBeNull()
  })

  /**
   * Phase 121: the degradation has to be doing work. A `manager` holds
   * `jobs:manage` and not `accounting:journal`, so before this they failed one
   * step later than a salesperson — after the schedule of values was written.
   */
  it('withholds for a manager too, who used to fail one step further in', async () => {
    const manager = await addUserWithRole(fixture, 'manager')

    expect(ROLE_PERMISSIONS.manager).toContain('jobs:manage')
    expect(ROLE_PERMISSIONS.manager).not.toContain('accounting:journal')
    expect(ROLE_PERMISSIONS.sales).not.toContain('jobs:manage')

    const result = await convertWonOpportunity(manager, opportunityId, { createInvoice: true })

    expect(result.billingWithheld).toBe(true)
    expect(result.sovStageCount).toBe(0)
  })

  it('tells the person what was left undone, and who can finish it', () => {
    const action = readFileSync('src/app/actions/crm.ts', 'utf8')

    expect(action).toContain('The billing schedule and the deposit invoice were not raised')
    expect(action).toContain('accounting:journal')
    expect(action).toContain('jobs:manage')
  })
})
