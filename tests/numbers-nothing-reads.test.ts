import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { RegistryError } from '@/modules/errors/registry'
import {
  PINNED_CLAIMS,
  claimStands,
  pinnedClaimArgues,
  pinnedClaimFor,
  readableProse,
  type MeasuredFacts,
} from '@/modules/source/claims'

/**
 * Numbers in prose that nothing reads (Phase 179).
 *
 * ADR 0178 nominated a clean full run on the argument that three phases had
 * each found a tree-wide tripwire red for reasons nobody had seen. The run
 * earns its place and it cannot find this, because this defect is in sentences.
 *
 * The measurement that opened the phase, before a line of this was written:
 *
 * ```
 * deploy-migration-count          says  98   is  98   ok
 * runbook-table-count             says 181   is 182
 * runbook-policed-tables          says 163   is 162
 * deploy-policed-tables           says 163   is 162
 * readme-owner-table-count        says 181   is 182
 * rls-owner-table-count           says 181   is 182
 * rls-bypass-owner-table-count    says 181   is 182
 * rls-policed-table-count         says 163   is 162
 * rls-auditor-policy-count        says 163   is 162
 * rls-bites-owner-table-count     says 181   is 182
 * references-rollout-total        says 271   is 274
 * ```
 *
 * **Ten of eleven wrong, and the one that was right is the one Stage A had
 * already pinned with a test of its own.** Every count a test reads — 111
 * writes, 911 reads, 274 references, 34 registries — was right, with the five
 * exceptions the same run caught in the same hour, which is the point: those
 * five are now right because a test said so. Every count only prose held had drifted.
 *
 * That is one mechanism, applied to nine numbers and not to eleven others, and
 * the result is not ambiguous. So Stage A's remedy is generalised here, in its
 * own words: *"fixing it again in a year is not the remedy; the remedy is that
 * the number is in a place something reads."*
 */

/** Measured here, and passed in, so the register itself needs no connection. */
async function measure(): Promise<MeasuredFacts> {
  const one = async (query: ReturnType<typeof sql>) => {
    const rows = (await db.execute(query)) as unknown as { total: number }[]
    return Number(rows[0].total)
  }

  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
    entries: unknown[]
  }

  return {
    tables: await one(sql`
      select count(*)::int as total from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `),
    policedTables: await one(sql`
      select count(distinct tablename)::int as total from pg_policies
      where schemaname = 'public'
    `),
    companyScopedTables: await one(sql`
      select count(*)::int as total from information_schema.columns
      where table_schema = 'public' and column_name = 'company_id'
    `),
    migrations: journal.entries.length,
    /*
      Both measured the way `tests/the-id-a-caller-hands-in.test.ts` measures
      them, from `pg_constraint` — a foreign key from one tenant-scoped table to
      another, and the subset whose key carries the tenant.
    */
    references: await one(sql`
      select count(*)::int as total
      from pg_constraint c
      where c.contype = 'f'
        and exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = c.conrelid::regclass::text
            and column_name = 'company_id'
        )
        and exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = c.confrelid::regclass::text
            and column_name = 'company_id'
        )
    `),
    compositeReferences: await one(sql`
      select count(*)::int as total
      from pg_constraint c
      where c.contype = 'f' and array_length(c.conkey, 1) > 1
        and exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = c.conrelid::regclass::text
            and column_name = 'company_id'
        )
    `),
  }
}

describe('the register itself', () => {
  it('argues every claim by what a reader does with the number', () => {
    /**
     * Phase 101's device, with the floor set on a particular question. "This
     * number should be right" is not an argument — every number should be
     * right. The argument has to say what a reader *does* with it, because a
     * count nobody acts on is not worth a test and a count somebody copies into
     * a security questionnaire is worth two.
     */
    expect(PINNED_CLAIMS.flatMap((claim) => pinnedClaimArgues(claim))).toEqual([])
  })

  it('declares thirteen claims, twelve of them pinned', () => {
    /**
     * Phase 126, and the second number is the honest one: one entry is declared
     * with no measure, on Phase 139's rule.
     *
     * Thirteen and not twelve because the first draft had twelve. The audit that
     * produced this register read three operational documents and missed
     * `docs/SPEC-AUDIT.md` — the one that answers "is tenant isolation done" —
     * and the verification run caught it still carrying the old figure. A
     * register assembled by grepping the documents somebody thought of is this
     * phase's own subject one level up.
     */
    expect(PINNED_CLAIMS).toHaveLength(13)
    expect(new Set(PINNED_CLAIMS.map((claim) => claim.key)).size).toBe(13)
    expect(PINNED_CLAIMS.filter((claim) => claim.measure !== null)).toHaveLength(12)
  })

  it('names the one it cannot pin, and why', () => {
    /**
     * Phase 139's device. A register that quietly covered eleven of twelve
     * would be the thing this phase is about, one level up — so the unpinned
     * entry is a declared entry with a reason, not an omission.
     *
     * The reason is specific and fixable: the scans that count writes and reads
     * live inside `tests/isolation-guards.test.ts` and
     * `tests/isolation-reads.test.ts`, so nothing outside those files can ask
     * for the number.
     */
    const unpinned = PINNED_CLAIMS.filter((claim) => claim.measure === null)

    expect(unpinned.map((claim) => claim.key)).toEqual(['isolation-guard-distribution'])
    expect(unpinned[0].because).toContain('tests/isolation-guards.test.ts')
    expect(unpinned[0].because).toContain('Not pinned')
  })

  it('throws on a claim nobody declared', () => {
    expect(() => pinnedClaimFor('readme-dependency-count')).toThrow(RegistryError)

    try {
      pinnedClaimFor('readme-dependency-count')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('PINNED_CLAIMS')
      expect((error as RegistryError).message).toContain('deploy-migration-count')
    }
  })
})

describe('reading a sentence that was wrapped', () => {
  it('collapses a line break, a JSDoc margin and a split string literal', () => {
    /**
     * Every one of these is real, and without the first the `README` and
     * `RUNBOOK` claims could not be matched at all — they wrap mid-sentence.
     * Without the second, nothing in a module docstring could. Without the
     * third, nothing in a register entry, which is where five of the twelve
     * live.
     */
    expect(readableProse('owns all 181\ntables')).toBe('owns all 181 tables')
    // The closing `*/` loses its asterisk to the margin rule and comes back as
    // a bare `/`. Harmless and asserted rather than tidied: the job is to make
    // a wrapped *sentence* matchable, and no claim's pattern reaches the end of
    // a comment block. Tightening the rule to spare the terminator would be a
    // special case earning nothing.
    expect(readableProse('/**\n * owns all 181\n * tables\n */')).toBe('/** owns all 181 tables /')
    expect(readableProse("'owns all 181 ' +\n      'tables here'")).toBe("'owns all 181 tables here'")
  })
})

describe('every pinned number', () => {
  it('says what is measured', async () => {
    /**
     * The whole phase in one assertion. Each entry is checked against the
     * database, the migration journal or `pg_constraint` — and a failure names
     * the file, what it says, and what it is, because the fix is to edit the
     * sentence rather than to move the number.
     */
    const facts = await measure()

    const problems = PINNED_CLAIMS.filter((claim) => claim.measure !== null)
      .map((claim) => claimStands(claim, readFileSync(claim.file, 'utf8'), facts))
      .filter((verdict) => !verdict.ok)
      .map((verdict) => (verdict as { why: string }).why)

    expect(problems).toEqual([])
  })

  it('fails loudly when a sentence is reworded, rather than going quiet', async () => {
    /**
     * The edge that matters more than the arithmetic. A pattern matching
     * nothing is a pin that stopped pinning: somebody reflowed the paragraph
     * and the check went green forever. That is Phase 160's shape — a control
     * that cannot fire — inside the test written to prevent it.
     */
    const facts = await measure()
    const claim = pinnedClaimFor('rls-policed-table-count')

    const reworded = claimStands(claim, 'the mechanism is installed everywhere', facts)
    expect(reworded.ok).toBe(false)
    expect((reworded as { why: string }).why).toContain('no longer contains this claim')

    const twice = claimStands(
      claim,
      'installed on all 162 policed tables … installed on all 162 policed tables',
      facts,
    )
    expect(twice.ok).toBe(false)
    expect((twice as { why: string }).why).toContain('2 times')
  })

  it('catches a number that is one out', async () => {
    // Phase 121: a check only ever seen to agree is not a check. So here it is,
    // disagreeing — with the exact figure this phase found in the runbook.
    const facts = await measure()
    const claim = pinnedClaimFor('runbook-table-count')

    const stale = claimStands(claim, 'Expect `181 tables present, ledger included.`', facts)

    expect(stale.ok).toBe(false)
    expect((stale as { why: string }).why).toBe(
      `docs/RUNBOOK-FIRST-COMPANY.md says 181; it is ${facts.tables}.`,
    )
  })
})

describe('what the database actually holds', () => {
  it('measures more tables than are policed, which is the disclosure', async () => {
    /**
     * Not a tautology, and worth its own assertion: `RLS_ROLLOUT`'s honest
     * summary rests on the gap. Four tables carry a `company_id` and are
     * deliberately unpoliced — they are read to decide who the caller is,
     * strictly before any tenant can be set — and a measurement that found the
     * two numbers equal would mean somebody had policed them.
     */
    const facts = await measure()

    expect(facts.policedTables).toBeLessThan(facts.companyScopedTables)
    expect(facts.companyScopedTables).toBeLessThan(facts.tables)
    expect(facts.compositeReferences).toBeLessThan(facts.references)
  })
})
