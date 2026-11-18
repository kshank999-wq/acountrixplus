import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCompanyFixture, addUserWithRole, insertTransaction } from './helpers'
import {
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@/modules/permissions'
import { RegistryError } from '@/modules/errors/registry'
import {
  DEGRADING_READS,
  absentRefusals,
  degradingRead,
  unestablishedReads,
} from '@/modules/source/degrading-reads'
import {
  OPEN_ACTS,
  callArguments,
  functionBody,
  permissionChecksIn,
} from '@/modules/source/gate-forms'
import { suggestCategory, suggestRule } from '@/modules/ai/bookkeeping'
import { transactionContext } from '@/modules/ai/retrieval'

/**
 * The refusal that says the record does not exist (Phase 215).
 *
 * ADR 0214 nominated **the soft refusal that is not a permission** and asked
 * whether any caller drops the refusal it is handed. None does — the first
 * nomination in five phases that named nothing.
 *
 * What measuring it found is next door: of the five permission-gated reads in
 * `ai/retrieval.ts`, four answer an absence and should, and one was the subject
 * of an act and could not say why it was absent.
 */

const holds = (role: Role, permission: Permission) =>
  (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission)

const holders = (permission: Permission) => ROLE_NAMES.filter((role) => holds(role, permission))

describe('the refusal that names the reason', () => {
  /**
   * The defect, as a person met it. A salesperson holds `ai:use` and not
   * `bookkeeping:view`, and this said "That transaction was not found" about a
   * transaction that exists.
   */
  it('tells a reader who may not see bookkeeping that, rather than that the row is missing', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const sales = await addUserWithRole(fixture, 'sales')
    const transaction = await insertTransaction(fixture, {
      amountCents: -4_250,
      description: 'TIMBER MERCHANT',
      merchantName: 'Hallam Timber',
    })

    // The premise.
    expect(holds('sales', 'ai:use')).toBe(true)
    expect(holds('sales', 'bookkeeping:view')).toBe(false)

    const refused = await suggestCategory(sales, transaction.id)

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.reason).toBe('permission')
    expect(refused.message).toBe('Your role does not include bookkeeping.')
    // The sentence that was there before, which sent them looking.
    expect(refused.message).not.toMatch(/not found/i)
  })

  it('still says not found when the record really is not there', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    expect(holds('bookkeeper', 'bookkeeping:view')).toBe(true)

    const refused = await suggestCategory(bookkeeper, '00000000-0000-4000-8000-000000000000')

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.reason).toBe('not_found')
    expect(refused.message).toBe('That transaction was not found.')
  })

  /** Both acts, because both carried the same collapsed sentence. */
  it('names the reason in the rule suggestion too', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const sales = await addUserWithRole(fixture, 'sales')
    const transaction = await insertTransaction(fixture, {
      amountCents: -1_100,
      description: 'FUEL',
    })

    const refused = await suggestRule(sales, transaction.id)

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.reason).toBe('permission')
  })

  /** And the read itself, which is where the two reasons were one. */
  it('answers which of the two happened', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const sales = await addUserWithRole(fixture, 'sales')
    const transaction = await insertTransaction(fixture, {
      amountCents: -900,
      description: 'SUNDRIES',
    })

    const withheld = await transactionContext(sales, transaction.id)
    expect(withheld.ok).toBe(false)
    if (!withheld.ok) expect(withheld.reason).toBe('permission')

    const missing = await transactionContext(
      fixture.ctx,
      '00000000-0000-4000-8000-000000000000',
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('not_found')

    const read = await transactionContext(fixture.ctx, transaction.id)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.value.description).toBe('SUNDRIES')
  })

  /**
   * Phase 70, stated as a count rather than as a hope: these two acts were the
   * only ones in the module with a `not_found` and no `permission`, and now
   * every act that can refuse for either reason can say which.
   */
  it('leaves no act in the module with a not_found it cannot explain', () => {
    const module = readFileSync('src/modules/ai/bookkeeping.ts', 'utf8')
    const assistants = readFileSync('src/modules/ai/assistants.ts', 'utf8')

    for (const source of [module, assistants]) {
      expect(source).toMatch(/reason: 'permission'|reason: found\.reason|result\.reason/)
    }

    // The house sentence, used by the other five acts and now by these two.
    expect(readFileSync('src/modules/ai/retrieval.ts', 'utf8')).toMatch(
      /Your role does not include bookkeeping\./,
    )
  })
})

describe('the register of reads that may answer empty', () => {
  /**
   * Not "no read returns empty" — four of the five should. The property is
   * about callers: a read whose absence a caller turns into a refusal must be
   * able to say why it is absent.
   */
  it('declares every permission check in src/modules that yields an absence', () => {
    const found = absentRefusals()

    expect(found.length).toBeGreaterThan(0)
    for (const refusal of found) {
      // Throws if undeclared, which is the assertion.
      const declared = degradingRead(refusal.file, refusal.symbol)
      expect(declared.permission).toBe(refusal.permission)
    }
  })

  /**
   * Phase 216 replaced this assertion, and the reason belongs here rather than
   * only in that phase's file.
   *
   * What stood here was `absentRefusalDefects()`, which asked whether a caller
   * that **refuses** on an absence can say why it is absent. It was the weaker
   * half of the right idea: the dangerous caller is the one that **answers**.
   * `reviewAnomalies` returned `ok: true` with "Not enough activity yet for a
   * useful review" to a reader who had been shown nothing, and `summarizeInbox`
   * published a model-written summary of an inbox it was not allowed to read —
   * and both passed the assertion that used to be on this line.
   */
  it('leaves no caller trusting a degrading read it has not established', () => {
    expect(unestablishedReads()).toEqual([])
  })

  it('holds the four that degrade, and every entry argues for itself', () => {
    expect(DEGRADING_READS).toHaveLength(4)
    expect(DEGRADING_READS.map((read) => read.symbol).sort()).toEqual([
      'accountOptions',
      'companyContext',
      'inboxShape',
      'recentTransactions',
    ])

    for (const read of DEGRADING_READS) {
      expect(read.why.length, read.symbol).toBeGreaterThan(80)
      expect(functionBody(read.file, read.symbol), read.symbol).not.toBeNull()
    }
  })

  /**
   * The entry that left. `transactionContext` was the fifth and is not in the
   * register, because it was fixed rather than declared — which is the only way
   * an entry should leave a register of this kind.
   */
  it('no longer counts the subject of an act among them', () => {
    expect(DEGRADING_READS.map((read) => read.symbol)).not.toContain('transactionContext')
    expect(absentRefusals().map((refusal) => refusal.symbol)).not.toContain('transactionContext')

    expect(() => degradingRead('src/modules/ai/retrieval.ts', 'transactionContext')).toThrow(
      RegistryError,
    )
  })

  /**
   * Phase 216 changed the sentence this pins, and the change is the correction
   * rather than a rewording.
   *
   * The refusal used to warn about "an absence standing in for a **refusal**",
   * which is the same wrong half as the falsifier above: it describes a caller
   * that turns an empty answer into a no. The defect is an absence standing in
   * for **data** — `reviewAnomalies` reading `[]` as "nothing unusual" and
   * saying so with `ok: true`. The refusal now names that, and names the
   * remedy: declare the degradation, or establish the permission first.
   */
  it('refuses a read nobody has declared, and says what goes wrong', () => {
    try {
      degradingRead('src/modules/ai/retrieval.ts', 'somethingNew')
      throw new Error('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      const message = (error as RegistryError).message
      expect(message).toMatch(/absence standing in for data/i)
      // Phase 47: a refusal has to name something the reader can act on.
      expect(message).toMatch(/every caller establishes the permission first/)
    }
  })

  /**
   * Ordering is the argument, and it is checked by source position rather than
   * asserted. `accountOptions` returning `[]` is ambiguous in principle and
   * `suggestCategory` does refuse on it — which is allowed only because it reads
   * `transactionContext` first, on the same permission, so the permission
   * question is already settled when the list turns out to be empty.
   */
  it('makes the ordering that licenses one refusal checkable', () => {
    const accounts = DEGRADING_READS.find((read) => read.symbol === 'accountOptions')
    expect(accounts?.settledBy).toBe('transactionContext')
    expect(accounts?.permission).toBe('bookkeeping:view')

    const body = functionBody('src/modules/ai/bookkeeping.ts', 'suggestCategory')
    expect(body).not.toBeNull()
    expect(body!.indexOf('transactionContext')).toBeGreaterThan(-1)
    expect(body!.indexOf('transactionContext')).toBeLessThan(body!.indexOf('accountOptions'))

    // And the read it defers to really does answer the permission question.
    const subject = functionBody('src/modules/ai/retrieval.ts', 'transactionContext')
    expect(permissionChecksIn(subject!).literal).toContain('bookkeeping:view')
    expect(subject!).toMatch(/reason: 'permission'/)

    // The three entries with no `settledBy` are the ones no caller refuses on.
    const tolerated = DEGRADING_READS.filter((read) => !read.settledBy)
    expect(tolerated).toHaveLength(3)
  })
})

describe('the eleventh form a permission check can take', () => {
  /**
   * `ifPermitted(ctx, permission, read, fallback)` passes the permission as an
   * **argument to a wrapper**, which Phase 214's reader does not match — it
   * looks for `requirePermission(` and `can(`. Two phases after a phase that
   * found ten forms, there is an eleventh.
   */
  it('is invisible to the gate reader, which is why it is recorded here', () => {
    const body = functionBody('src/modules/ai/retrieval.ts', 'inboxShape')
    expect(body).not.toBeNull()

    // The act is gated on bookkeeping:view, and the reader sees nothing.
    expect(body!).toMatch(/ifPermitted\(/)
    expect(permissionChecksIn(body!).literal).toEqual([])
    expect(permissionChecksIn(body!).computed).toEqual([])

    // But this scan does see it, through the same bracket-balancing reader.
    const found = absentRefusals().filter((refusal) => refusal.symbol === 'inboxShape')
    expect(found).toHaveLength(1)
    expect(found[0].permission).toBe('bookkeeping:view')
  })

  /**
   * Why Phase 214's figures stand: checked rather than assumed. The wrapper is
   * module-private, every use is read-only, and no act that writes an audit
   * event behind no check calls it — so nothing in `OPEN_ACTS` is gated by a
   * form that register could not see.
   */
  it('reaches no act that writes an audit event', () => {
    const source = readFileSync('src/modules/ai/retrieval.ts', 'utf8')

    // Module private: declared without `export`.
    expect(source).toMatch(/\basync function ifPermitted</)
    expect(source).not.toMatch(/export async function ifPermitted/)

    for (const act of OPEN_ACTS) {
      const body = functionBody(act.file, act.symbol)
      expect(body, `${act.file}::${act.symbol}`).not.toBeNull()
      expect(body!, `${act.file}::${act.symbol}`).not.toMatch(/ifPermitted\(/)
    }
  })

  /** One reader for brackets, not two — `enclosing-function.test.ts`'s rule. */
  it('shares the bracket reader rather than copying it', () => {
    const args = callArguments("ifPermitted(ctx, 'bookkeeping:view', async () => db.q(a, b), [])", 11)

    expect(args[0]).toBe('ctx')
    expect(args[1]).toBe("'bookkeeping:view'")
    expect(args[3]).toBe('[]')
  })
})

describe('a gate that cannot refuse today', () => {
  /**
   * `companyContext` is the clearest case for degrading, and its refusal branch
   * cannot currently fire: its only two callers require `proposals:manage` or
   * `marketing:manage`, and every holder of either holds `crm:view`.
   *
   * Recorded rather than removed. It is belt and braces, which is exactly why it
   * is safe for it to be silent — and if a third caller arrives gated
   * differently, this assertion is what says the silence is no longer safe.
   */
  it('is unreachable through either of its callers, and says so', () => {
    const reachable = new Set([...holders('proposals:manage'), ...holders('marketing:manage')])

    for (const role of reachable) {
      expect(holds(role, 'crm:view'), role).toBe(true)
    }

    expect([...reachable].sort()).toEqual(['manager', 'marketing', 'owner', 'sales'])

    // The callers, named, so the premise above is checkable.
    const assistants = readFileSync('src/modules/ai/assistants.ts', 'utf8')
    const calls = assistants.match(/await companyContext\(/g) ?? []
    expect(calls).toHaveLength(2)

    for (const symbol of ['draftProposalSections', 'draftCampaignCopy']) {
      const body = functionBody('src/modules/ai/assistants.ts', symbol)
      expect(body!).toMatch(/companyContext\(/)
      const checks = permissionChecksIn(body!).literal
      expect(
        checks.includes('proposals:manage') || checks.includes('marketing:manage'),
        symbol,
      ).toBe(true)
    }
  })

  /** And nobody is misled by its silence, because nobody refuses on it. */
  it('degrades into a sentence rather than an error', () => {
    const retrieval = readFileSync('src/modules/ai/retrieval.ts', 'utf8')
    expect(retrieval).toMatch(/renderVoice/)

    const declared = degradingRead('src/modules/ai/retrieval.ts', 'companyContext')
    expect(declared.settledBy).toBeUndefined()
    expect(declared.permission).toBe('crm:view')
  })
})
