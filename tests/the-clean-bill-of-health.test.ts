import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { aiRequests } from '@/db/schema'
import { createCompanyFixture, addUserWithRole, insertTransaction } from './helpers'
import { ROLE_NAMES, ROLE_PERMISSIONS, type Permission, type Role } from '@/modules/permissions'
import {
  DEGRADING_READS,
  establishedByImplication,
  unestablishedReads,
} from '@/modules/source/degrading-reads'
import { functionBody, permissionChecksIn } from '@/modules/source/gate-forms'
import { reviewAnomalies, summarizeInbox } from '@/modules/ai/bookkeeping'

/**
 * The clean bill of health nobody checked (Phase 216).
 *
 * ADR 0215 nominated **the absence that is not a refusal at all** and asked what
 * the assistant says when it degrades. It says everything is fine.
 *
 * `recentTransactions` answers `[]` without `bookkeeping:view`, and
 * `reviewAnomalies` turned that into `ok: true` with "Not enough activity yet
 * for a useful review" — a clean bill of health on books the reader had never
 * been shown. `summarizeInbox` did not even branch: `inboxShape` hands it a
 * *shaped* empty, so it passed zeroes to the model and published the summary.
 */

const holds = (role: Role, permission: Permission) =>
  (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission)

describe('an answer about books the reader was never shown', () => {
  /**
   * The defect as a person met it. Reachable: these are server actions, and
   * Phase 214's own finding is that a page guard does not protect an HTTP
   * endpoint.
   */
  it('refuses the anomaly review rather than reporting nothing unusual', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const sales = await addUserWithRole(fixture, 'sales')

    // Real activity, so "not enough activity" would be a false statement about
    // the company rather than a thin-data answer.
    for (let n = 0; n < 6; n += 1) {
      await insertTransaction(fixture, {
        amountCents: -1_000 * (n + 1),
        description: `SUPPLIER ${n}`,
        merchantName: `Supplier ${n}`,
      })
    }

    expect(holds('sales', 'ai:use')).toBe(true)
    expect(holds('sales', 'bookkeeping:view')).toBe(false)

    const result = await reviewAnomalies(sales)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('permission')
    expect(result.message).toBe('Your role does not include bookkeeping.')
    // The sentence that was there before, and the shape that made it dangerous.
    expect(result.message).not.toMatch(/not enough activity/i)
  })

  /** The real thin-data case is untouched: a short list is still a short list. */
  it('still says there is not enough activity when there is not enough activity', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    expect(holds('bookkeeper', 'bookkeeping:view')).toBe(true)

    const result = await reviewAnomalies(bookkeeper)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.message).toBe('Not enough activity yet for a useful review.')
    expect(result.findings).toEqual([])
  })

  /**
   * The summary, and the half that cost money. A shaped empty is the hardest
   * absence to catch because it looks exactly like data: there was no falsy
   * value to branch on, so the model was asked to describe an inbox the reader
   * was not allowed to see, and it obliged.
   */
  it('refuses the summary without spending a provider call on it', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const marketing = await addUserWithRole(fixture, 'marketing')

    await insertTransaction(fixture, { amountCents: -7_400, description: 'UNCATEGORISED' })

    expect(holds('marketing', 'ai:use')).toBe(true)
    expect(holds('marketing', 'bookkeeping:view')).toBe(false)

    const result = await summarizeInbox(marketing)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('permission')

    // It refused before the gateway, so nothing was metered. The old path
    // reached `ask`, which holds `ai:use` — which marketing has.
    const metered = await db
      .select({ id: aiRequests.id })
      .from(aiRequests)
      .where(eq(aiRequests.companyId, fixture.companyId))
    expect(metered).toEqual([])
  })

  /** Both roles that hold `ai:use` without `bookkeeping:view`, not just one. */
  it('refuses every role that could reach it', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })

    const reachable = ROLE_NAMES.filter(
      (role) => holds(role, 'ai:use') && !holds(role, 'bookkeeping:view'),
    )
    expect(reachable).toEqual(['sales', 'marketing'])

    for (const role of reachable) {
      const actor = await addUserWithRole(fixture, role)
      const anomalies = await reviewAnomalies(actor)
      const summary = await summarizeInbox(actor)

      expect(anomalies.ok, role).toBe(false)
      expect(summary.ok, role).toBe(false)
    }
  })
})

describe('the property Phase 215 should have asserted', () => {
  /**
   * Phase 215 asserted that a read whose absence a caller turns into a
   * **refusal** must say why. That is the wrong half: the dangerous caller is
   * the one that **answers**. Both of this phase's defects passed that
   * falsifier.
   */
  it('leaves no caller trusting a degrading read it has not established', () => {
    expect(unestablishedReads()).toEqual([])
  })

  it('replaced the weaker falsifier rather than keeping it alongside', () => {
    const source = readFileSync('src/modules/source/degrading-reads.ts', 'utf8')

    // Two falsifiers for one question is the defect this codebase names most
    // often, and the weaker one would have passed for the reason that made it
    // weak.
    expect(source).not.toMatch(/export function absentRefusalDefects/)
    expect(source).toMatch(/export function unestablishedReads/)
  })

  /**
   * Arm 2, which is the interesting one: a caller may establish a permission
   * without ever naming it, if every holder of what it does check holds it.
   * Computed from `ROLE_PERMISSIONS`, so it stops being true when the role
   * table changes — which is the difference between this and the pinned premise
   * Phase 215 left in a comment.
   */
  it('computes implication from the role table rather than claiming it', () => {
    expect(establishedByImplication('marketing:manage', 'crm:view')).toBe(true)
    expect(establishedByImplication('proposals:manage', 'crm:view')).toBe(true)
    expect(establishedByImplication('bookkeeping:view', 'bookkeeping:view')).toBe(true)

    // Not the other way about: plenty of people may see the books and not the CRM.
    expect(establishedByImplication('bookkeeping:view', 'crm:view')).toBe(false)
    expect(establishedByImplication('ai:use', 'bookkeeping:view')).toBe(false)
  })

  /** Each of the three arms is actually load-bearing for a real caller. */
  it('uses all three ways of establishing a permission', () => {
    // 1. Checked outright, by the two acts this phase fixed.
    for (const symbol of ['reviewAnomalies', 'summarizeInbox']) {
      const body = functionBody('src/modules/ai/bookkeeping.ts', symbol)
      expect(permissionChecksIn(body!).literal, symbol).toContain('bookkeeping:view')
    }

    // 2. By implication: `draftCampaignCopy` never names `crm:view`.
    const campaign = functionBody('src/modules/ai/assistants.ts', 'draftCampaignCopy')
    const checked = permissionChecksIn(campaign!).literal
    expect(checked).toContain('marketing:manage')
    expect(checked).not.toContain('crm:view')
    expect(campaign!).toMatch(/companyContext\(/)

    // 3. By a subject read consulted first, which is `settledBy`.
    const accounts = DEGRADING_READS.find((read) => read.symbol === 'accountOptions')
    expect(accounts?.settledBy).toBe('transactionContext')
    const suggest = functionBody('src/modules/ai/bookkeeping.ts', 'suggestCategory')
    expect(suggest!.indexOf('transactionContext')).toBeLessThan(suggest!.indexOf('accountOptions'))
  })
})

describe('the register that was wrong one commit after it was written', () => {
  it('still holds four reads, and records what it got wrong about one', () => {
    expect(DEGRADING_READS).toHaveLength(4)

    const recent = DEGRADING_READS.find((read) => read.symbol === 'recentTransactions')
    // The sentence Phase 215 wrote here was false, and the entry says so rather
    // than being quietly rewritten (Phase 179's shape: a figure or a claim
    // nothing reads is the one that rots).
    expect(recent?.why).toMatch(/nothing unusual is an answer only if you looked/i)

    const inbox = DEGRADING_READS.find((read) => read.symbol === 'inboxShape')
    expect(inbox?.why).toMatch(/shaped empty/i)
  })

  /**
   * The tree-wide claim, and the one that stays true as the module grows:
   * `bookkeeping.ts` was the only file in the AI module whose acts had no gate
   * of their own. Now every act that reaches a provider establishes a
   * permission.
   */
  it('leaves no act in the AI module reaching a provider ungated', () => {
    const files = ['accounts.ts', 'assistants.ts', 'bookkeeping.ts', 'design.ts']
    const ungated: string[] = []

    for (const name of files) {
      const path = `src/modules/ai/${name}`
      const source = readFileSync(path, 'utf8')

      for (const match of source.matchAll(/^export async function (\w+)/gm)) {
        const symbol = match[1]
        const body = functionBody(path, symbol)
        if (body === null || !/\bask\(/.test(body)) continue

        const checks = permissionChecksIn(body)
        if (checks.literal.length > 0 || checks.computed.length > 0) continue

        // The remaining way to be gated: a discriminated subject read.
        if (/transactionContext\(/.test(body)) continue

        ungated.push(`${name}::${symbol}`)
      }
    }

    expect(ungated).toEqual([])
  })
})
