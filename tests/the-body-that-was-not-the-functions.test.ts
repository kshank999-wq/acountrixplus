import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DECLARATION,
  declarationOffset,
  declaresFunction,
  enclosingSymbol,
  parameterNames,
  withoutComments,
} from '@/modules/source/enclosing'
import {
  GATE_RESOLVERS,
  functionBody,
  permissionChecksIn,
  resolveComputedGate,
} from '@/modules/source/gate-forms'
import {
  demandedBy,
  establishedBy,
  mislabelledGates,
  rolesSatisfying,
  serverActions,
  ungatedActions,
} from '@/modules/source/action-gates'
import { RegistryError } from '@/modules/errors/registry'
import { PermissionError, ROLE_PERMISSIONS, type Permission } from '@/modules/permissions'
import { createMarketingDocument, saveAsTemplate } from '@/modules/design/documents'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * The body that was not the function's (Phase 218).
 *
 * ADR 0217 nominated **the screen that offers what it will refuse** and
 * proposed, for each of the 71 page guards, measuring whether any role the guard
 * admits can perform any act the screen offers. Answering that means reading a
 * gate, and this phase found that gates could not be read:
 *
 * 1. `enclosingSpan`, `enclosingSymbol` and `declaresFunction` require the
 *    opening `(` to follow the name, so a **generic** function is invisible as a
 *    function boundary. `functionBody` used a looser reading that does see one,
 *    handed the offset to `enclosingSpan`, and got back the *previous* function's
 *    span running to the next declaration it could see — for `scoped`, `can`'s
 *    body from `can` to the end of the file.
 * 2. `functionBody` included the signature, so
 *    `requirePermission(ctx: ActorContext, permission: Permission)` read as a
 *    computed permission check on `requirePermission` itself.
 * 3. `gatesIn` caught `resolveComputedGate`'s refusal and pushed
 *    `company:manage`, so a supplied answer sat in the same array, with the same
 *    type, beside answers that had been read.
 *
 * Three readings, one of them a guess, and no way to tell which was which.
 */

const files = execSync(
  `cd ${process.cwd()} && find src/modules src/app -name '*.ts' -o -name '*.tsx' | sort`,
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')

/** Every exported top-level function in the tree, read from the source. */
const exported: { file: string; symbol: string; generic: boolean }[] = []
for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  for (const match of withoutComments(raw).matchAll(
    /^export (?:async )?function (\w+)\s*(<[^(]*>)?\(/gm,
  )) {
    exported.push({ file, symbol: match[1], generic: Boolean(match[2]) })
  }
}

describe('one reading of where a function begins', () => {
  it('finds enough functions, and enough generic ones, for the rest to mean anything', () => {
    expect(exported.length).toBeGreaterThan(2_000)
    expect(exported.filter((e) => e.generic).length).toBeGreaterThanOrEqual(12)
  })

  /**
   * The invariant nothing had ever asserted. `declarationOffset` points at a
   * declaration of `symbol`; `enclosingSymbol` asked about a position inside it
   * answers `symbol`; `declaresFunction` agrees it exists. All three or the
   * three readers have drifted apart again.
   */
  it('has all three readers agree about every exported function', () => {
    const disagree: string[] = []

    for (const { file, symbol } of exported) {
      const raw = readFileSync(file, 'utf8')
      const at = declarationOffset(raw, symbol)
      if (at === null) {
        disagree.push(`${file}:${symbol} declarationOffset -> null`)
        continue
      }
      // A position inside the declaration itself: past the parameter list's
      // opening bracket, whatever `export`/`async`/`<T>` precedes it.
      const named = enclosingSymbol(raw, raw.indexOf('(', at) + 1)
      if (named !== symbol) disagree.push(`${file}:${symbol} enclosingSymbol -> ${named}`)
      if (!declaresFunction(raw, symbol)) disagree.push(`${file}:${symbol} declaresFunction -> false`)
    }

    expect(disagree).toEqual([])
  })

  /**
   * Phase 121: a check that is seen to disagree rather than only to agree. The
   * pattern this phase replaced is applied to the same tree, and it has to miss
   * exactly the generic functions — otherwise the test above is passing for a
   * reason other than the fix.
   */
  it('fails on the pattern it replaced, and only for the generic functions', () => {
    const old = /^(?:export )?(?:async )?function (\w+)\(/gm

    const missed = exported.filter(({ file, symbol }) => {
      const blanked = withoutComments(readFileSync(file, 'utf8'))
      return ![...blanked.matchAll(old)].some((match) => match[1] === symbol)
    })

    expect(missed.length).toBeGreaterThanOrEqual(12)
    expect(missed.every((m) => m.generic)).toBe(true)
    // And the new one finds every single one of them.
    expect(
      missed.filter((m) => !new RegExp(DECLARATION, 'm').test(withoutComments(readFileSync(m.file, 'utf8')))),
    ).toEqual([])
  })

  /**
   * The case that found it, pinned by name. `scoped` is generic and `can` is
   * the declaration above it, so the old reading answered `can` — and because
   * nothing after `can` in `context.ts` is non-generic, the span ran to the end
   * of the file: every gate in the rest of it, under one name.
   */
  it('gives a generic function its own body rather than the previous function’s', () => {
    const file = 'src/modules/tenancy/context.ts'
    const whole = readFileSync(file, 'utf8')

    const body = functionBody(file, 'scoped')

    expect(body).not.toBeNull()
    expect(body).toContain('companyId')
    expect(body).not.toContain('hasPermission(ctx.role')
    expect(body!.length).toBeLessThan(whole.length / 2)
  })

  it('lets the scan follow a generic same-file helper', () => {
    const src = readFileSync('src/modules/tenancy/context.ts', 'utf8')

    expect(declaresFunction(src, 'scoped')).toBe(true)
    expect(declaresFunction(src, 'assertOwnedBy')).toBe(true)
  })
})

describe('a signature is not a body', () => {
  /**
   * The permission checker reading its own declaration as a check. Four
   * functions in `tenancy/context.ts` did it, and because `permission:
   * Permission` resolves to nothing, each became an invented `company:manage`.
   */
  it('does not read a parameter list as a permission check', () => {
    for (const symbol of ['requirePermission', 'can', 'scoped', 'assertOwnedBy']) {
      const body = functionBody('src/modules/tenancy/context.ts', symbol)
      expect(body, symbol).not.toBeNull()
      expect(permissionChecksIn(body!).computed, symbol).toEqual([])
    }
  })

  it('still sees a real check in the same file', () => {
    const body = functionBody('src/modules/receivables/send.ts', 'sendInvoice')

    expect(permissionChecksIn(body!).literal).toContain('accounting:journal')
  })

  /**
   * A check applied to a permission the function did not choose is kept under
   * its own name. Dropping it would make these read as ungated (ADR 0134's
   * direction); answering it is what the invented `company:manage` did.
   */
  it('names a forwarded check rather than dropping or answering it', () => {
    const file = 'src/modules/ai/retrieval.ts'
    const src = readFileSync(file, 'utf8')
    const checks = permissionChecksIn(functionBody(file, 'ifPermitted')!, parameterNames(src, 'ifPermitted'))

    expect(checks.forwarded).toContain('permission')
    expect(checks.computed).toEqual([])
    expect(checks.literal).toEqual([])
  })

  it('reads the list expression rather than the lambda’s parameter', () => {
    const file = 'src/modules/audit/index.ts'
    const src = readFileSync(file, 'utf8')
    const checks = permissionChecksIn(functionBody(file, 'historyFor')!, parameterNames(src, 'historyFor'))

    expect(checks.forwarded).toContain('permission')
    expect(checks.computed).toContain('permissionToRead(entityType)')
  })
})

describe('the catch that guessed', () => {
  /**
   * The register has to cover the tree, not a sample of it. `GATE_RESOLVERS`
   * declared five expressions while the tree held twenty, and the gap was
   * invisible because the only consumer answered the other fifteen itself.
   */
  it('declares every computed gate expression in the tree', () => {
    const undeclared = new Map<string, string[]>()

    for (const { file, symbol } of exported) {
      if (file.startsWith('src/modules/source/')) continue
      const body = functionBody(file, symbol)
      if (body === null) continue
      for (const expression of permissionChecksIn(
        body,
        parameterNames(readFileSync(file, 'utf8'), symbol),
      ).computed) {
        if (expression in GATE_RESOLVERS) continue
        undeclared.set(expression, [...(undeclared.get(expression) ?? []), `${file}:${symbol}`])
      }
    }

    expect([...undeclared.keys()]).toEqual([])
  })

  it('keeps no resolver entry that matches nothing in the tree', () => {
    const seen = new Set<string>()
    for (const { file, symbol } of exported) {
      if (file.startsWith('src/modules/source/')) continue
      const body = functionBody(file, symbol)
      if (body === null) continue
      for (const expression of permissionChecksIn(
        body,
        parameterNames(readFileSync(file, 'utf8'), symbol),
      ).computed) {
        seen.add(expression)
      }
    }

    expect(Object.keys(GATE_RESOLVERS).filter((key) => !seen.has(key))).toEqual([])
  })

  /** Phase 47: the refusal names what the reader has to do about it. */
  it('refuses an expression nobody has declared, rather than answering it', () => {
    try {
      resolveComputedGate('permissionFor(invented.kind, %)')
      throw new Error('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      const message = (error as RegistryError).message
      expect(message).toMatch(/No resolver is declared/)
      expect(message).toMatch(/wrongly in silence/)
      expect(message).toMatch(/Add an entry naming every permission/)
    }
  })

  /**
   * The whole population resolves. Before this phase, 11 of the 329 acts could
   * not have — and did not fail, because the catch answered for them.
   */
  it('reads a gate for every server action without inventing one', () => {
    expect(serverActions()).toHaveLength(329)
    expect(() => serverActions().forEach((key) => {
      const [file, action] = key.split('::')
      establishedBy(`src/app/actions/${file}.ts`, action)
    })).not.toThrow()
  })

  /**
   * The sharpest of the eleven. Reported as `company:manage` — owner only —
   * while the code gates a customer merge on `crm:manage` and a supplier merge
   * on `accounting:journal`. A merge is irreversible, which is exactly the kind
   * of act a register of gates must be right about.
   */
  it('reads a merge as the two permissions it actually takes', () => {
    const gate = establishedBy('src/modules/parties/service.ts', 'mergeParties')

    expect([...gate].sort()).toEqual(['accounting:journal', 'crm:manage'])
    expect(gate).not.toContain('company:manage')
    expect(rolesSatisfying([gate])).toContain('manager')
    expect(rolesSatisfying([gate])).toContain('accountant')
  })

  it('leaves the acts that really are owner-only alone', () => {
    const owners = serverActions()
      .map((key) => key.split('::'))
      .filter(([file, action]) =>
        establishedBy(`src/app/actions/${file}.ts`, action).includes('company:manage'),
      )

    // 34 before the fix, of which 11 were told they held it.
    expect(owners).toHaveLength(23)
  })

  it('does not disturb the answers Phase 214 and Phase 217 pinned', () => {
    expect(ungatedActions()).toHaveLength(38)
    expect(mislabelledGates()).toEqual([])
  })
})

describe('what an act will demand, which is a third question', () => {
  /**
   * `establishedBy` stops at the first gate and `authorityOf` unions one file.
   * Neither answers *if this person presses the button, will it work?*
   */
  it('separates the first gate on the path from every gate on it', () => {
    const file = 'src/app/actions/parties.ts'

    expect(establishedBy(file, 'updateCustomerAction')).toEqual(['crm:view'])

    const demanded = demandedBy(file, 'updateCustomerAction')
    expect(demanded).toContainEqual(['crm:view'])
    expect(demanded).toContainEqual(['crm:manage'])
    // Which is the point: a screen reading the first gate would have concluded
    // that anybody who may read a customer may correct one.
    expect(rolesSatisfying(demanded)).not.toContain('marketing')
  })

  /**
   * Two literal checks are a conjunction and one computed check is a
   * disjunction, and a flat `Permission[]` cannot tell them apart.
   */
  it('reads two literal checks as both and one computed check as either', () => {
    const both = demandedBy('src/app/actions/drawers.ts', 'closeShiftAction')
    expect(both).toContainEqual(['accounting:journal'])
    expect(both).toContainEqual(['accounting:view'])
    expect(rolesSatisfying(both)).toEqual(['owner', 'accountant'])

    const either = demandedBy('src/app/actions/evidence.ts', 'resolveNoteAction')
    expect(either).toHaveLength(1)
    expect(either[0].length).toBeGreaterThan(3)
    // A bookkeeper manages bookkeeping subjects, so the single clause admits
    // them — which the flattened reading could not express.
    expect(rolesSatisfying(either)).toContain('bookkeeper')
  })

  /**
   * The over-collection this phase walked into, and the half of it that can be
   * read off the source exactly.
   *
   * `sendInvoice` gates on `accounting:journal` and then calls
   * `logCommunication`, which requires `crm:manage` — so a transitive walk
   * concluded an accountant cannot send an invoice. They can: the call is
   * `.catch`ed, with the trade written beside it.
   */
  it('does not demand a permission whose refusal is swallowed at the call', () => {
    const demanded = demandedBy('src/modules/receivables/send.ts', 'sendInvoice')

    expect(demanded).toContainEqual(['accounting:journal'])
    expect(demanded.flat()).not.toContain('crm:manage')
    expect(rolesSatisfying(demanded)).toContain('accountant')
  })

  it('has something to exclude, so that exclusion is not vacuous', () => {
    // Phase 121 again: the swallowed call really does carry a stricter gate.
    expect(establishedBy('src/modules/engagement/communications.ts', 'logCommunication')).toEqual([
      'crm:manage',
    ])
    expect(ROLE_PERMISSIONS.accountant).not.toContain('crm:manage' as Permission)
  })

  /**
   * And the half that could not be read when this was written, which Phase 219
   * read: `demandedBy` is the `may` question, so a gate on a branch belongs in
   * its answer and this assertion stands.
   *
   * The sentence here used to say `logTime` reaches `users:manage` *"via
   * `loadOwnEditable`, on a branch"*. The conclusion was right and the
   * mechanism was wrong — `loadOwnEditable` is not on `logTime`'s path at all,
   * and the check is `logTime`'s own one-line `if`. Corrected here rather than
   * deleted, because a register that edits its own history teaches nothing.
   */
  it('reports a gate that sits on a branch, which is the may question', () => {
    const demanded = demandedBy('src/app/actions/timebilling.ts', 'logTimeAction')

    expect(demanded.flat()).toContain('users:manage')
    // Not a defect in the screen: a conditional cannot be read off the source,
    // which is why ADR 0218 nominates a register rather than a deeper scan.
    expect(demanded.flat()).toContain('accounting:view')
  })
})

describe('the screen and the act, now that a gate can be read', () => {
  /**
   * The nomination, measured. It predicted that nine acts had just become
   * stricter than the screens offering them and named three screens on which
   * `readonly` could press nothing. All three already passed the right flag:
   * `/settings/chasing` and `/settings/statements` hand their board
   * `canManage={can(actor, 'accounting:journal')}` and `/jobs/cost-codes`
   * hands its library `canManage={can(actor, 'jobs:manage')}`.
   *
   * What the screens actually do is pass **73** permission flags to 54
   * components, which the nomination's "71 guards against 11 checks" framing had
   * no place for.
   */
  it('computes a flag for every control, not just a guard for the screen', () => {
    const pages = execSync(
      `cd ${process.cwd()} && grep -rl "can(actor," src/app --include=*.tsx --include=*.ts`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')

    let guards = 0
    let flags = 0
    for (const page of pages) {
      const src = readFileSync(page, 'utf8')
      guards += [...src.matchAll(/if \(!can\(actor, '[^']+'\)/g)].length
      flags += [...src.matchAll(/^\s*\w+=\{can\(actor, '[^']+'\)\}/gm)].length
      flags += [...src.matchAll(/^\s*const \w+ = can\(actor, '[^']+'\)/gm)].length
    }

    expect(guards).toBe(71)
    expect(flags).toBeGreaterThanOrEqual(73)
  })

  it('names the three screens the nomination said would be bare', () => {
    for (const [page, permission] of [
      ['src/app/settings/chasing/page.tsx', 'accounting:journal'],
      ['src/app/settings/statements/page.tsx', 'accounting:journal'],
      ['src/app/jobs/cost-codes/page.tsx', 'jobs:manage'],
    ] as const) {
      expect(readFileSync(page, 'utf8'), page).toContain(`canManage={can(actor, '${permission}')}`)
    }
  })

  /**
   * The one flag of the 73 that disagreed with its act. Raising an invoice from
   * a proposal's schedule is a ledger act, and the button sat behind
   * `proposals:manage` — so `manager` and `sales`, two of the three roles the
   * screen admits, were offered a control that refused them.
   *
   * `shop/page.tsx` already named this flag `canBill`, beside its own
   * `canManage`, for the identical reason.
   */
  it('asks for the ledger permission before offering to raise an invoice', () => {
    const page = readFileSync('src/app/crm/proposals/page.tsx', 'utf8')
    const list = readFileSync('src/app/crm/proposals/proposal-list.tsx', 'utf8')

    expect(page).toContain("const canBill = can(actor, 'accounting:journal')")
    expect(list).toContain('{canManage && canBill && nextIndex >= 0 && (')
    expect(establishedBy('src/app/actions/crm.ts', 'billStageAction')).toEqual([
      'accounting:journal',
    ])
  })

  it('keeps the precedent it copied', () => {
    expect(readFileSync('src/app/shop/page.tsx', 'utf8')).toContain(
      "canBill={can(actor, 'accounting:journal')}",
    )
    expect(readFileSync('src/app/shop/board.tsx', 'utf8')).toContain('{canBill && (')
  })
})

describe('the answer written out again, thirty lines down', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Ridgeline Studio' })
  })

  /**
   * `permissionFor` exists because writing the answer out again *"refuses a
   * marketer the right to reorder their own creative"* — and `saveAsTemplate`,
   * in the same file, required `proposals:manage` outright. The designer is
   * mounted by two screens, and in the creative studio a marketer was shown
   * *Save as template* and refused by it.
   */
  it('lets a marketer save their own creative as a template', async () => {
    const marketing = await addUserWithRole(fixture, 'marketing')
    const document = await createMarketingDocument(marketing, { name: 'Spring flyer' })

    const template = await saveAsTemplate(marketing, document.id, {
      key: 'spring-flyer',
      name: 'Spring flyer',
    })

    expect(template.kind).toBe('marketing')
  })

  it('still refuses somebody with neither kind of permission', async () => {
    const document = await createMarketingDocument(fixture.ctx, { name: 'Summer flyer' })
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await expect(
      saveAsTemplate(bookkeeper, document.id, { key: 'summer', name: 'Summer' }),
    ).rejects.toBeInstanceOf(PermissionError)
  })

  it('reads as the resolver its own module declares, not as a literal', () => {
    const body = functionBody('src/modules/design/documents.ts', 'saveAsTemplate')

    expect(permissionChecksIn(body!).computed).toContain("permissionFor(document.kind, 'manage')")
    expect(permissionChecksIn(body!).literal).not.toContain('proposals:manage')
  })
})
