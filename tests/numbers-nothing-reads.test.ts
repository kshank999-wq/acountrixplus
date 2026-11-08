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
import { isolationCounts } from '@/modules/source/isolation-scan'
import { BUILT_IN_PROMPTS } from '@/modules/ai/prompts'
import { PHASE_DELIVERABLES } from '@/modules/source/phases'

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
      The four the thirteenth claim is about (Phase 187). From the source scan
      rather than the database, which is why this entry could not be measured
      until the scan left two test files and became a module.
    */
    ...isolationCounts(),
    /*
      Distinct keys, not entries (Phase 195). `insights.business` has two
      versions and one capability, so counting entries would report eleven
      things the AI module can be asked to do when there are ten.
    */
    promptKeys: new Set(BUILT_IN_PROMPTS.map((prompt) => prompt.key)).size,
    /*
      The register that replaced §20's last unmeasured sentence (Phase 199).
      Its own test holds it to §20's wording; this holds the audit's number to
      the register.
    */
    phaseDeliverables: PHASE_DELIVERABLES.length,
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

  it('declares fifteen claims, all of them pinned', () => {
    /**
     * Phase 126, and the second number is no longer the honest half: since
     * Phase 187 there is no unmeasured entry.
     *
     * Thirteen and not twelve because the first draft had twelve. The audit that
     * produced this register read three operational documents and missed
     * `docs/SPEC-AUDIT.md` — the one that answers "is tenant isolation done" —
     * and the verification run caught it still carrying the old figure. A
     * register assembled by grepping the documents somebody thought of is this
     * phase's own subject one level up.
     *
     * Fourteen since Phase 194, and the fourteenth is a *second* claim in
     * `docs/SPEC-AUDIT.md` — the file the paragraph above records this
     * register having missed the first time. Re-measuring that audit bullet by
     * bullet found exactly one number in it that had moved, its table count,
     * 181 to 185. Pinned for what the sentence stands for rather than for its
     * size: "done — 181 tables" reads as a section somebody counted, and the
     * count is the only part of it a machine can keep honest.
     *
     * Fifteen since Phase 195, and the fifteenth is a *third* claim in the
     * same audit — its §11 prompt count, pinned on distinct keys rather than
     * on entries, because that phase added a second version of one prompt and
     * kept the first. Three entries in one file is the register reporting
     * which document it most expects to go stale.
     *
     * Eighteen since Phase 199, and the eighteenth is a *fourth* claim in the
     * same audit — §20's deliverable count, which replaced the file's last
     * unmeasured sentence. Four of eighteen entries in one document is this
     * register's own answer to which file it most expects to go stale, and
     * that document is the one this process reads to decide what to build.
     */
    expect(PINNED_CLAIMS).toHaveLength(18)
    expect(new Set(PINNED_CLAIMS.map((claim) => claim.key)).size).toBe(18)
    expect(PINNED_CLAIMS.filter((claim) => claim.measure !== null)).toHaveLength(18)
  })

  it('pins all four numbers of the sentence that states four', () => {
    /**
     * The entry this phase was for. It was declared with `measure: null` for
     * eight phases on Phase 139's rule — a register that names what is not
     * wired beats one that looks complete and covers twelve of thirteen — and
     * it then drifted in **five consecutive phases** that touched a read,
     * corrected by hand each time.
     *
     * All four, not the first. A pattern capturing one number of four is three
     * numbers nobody checks, which is the same defect as not pinning the
     * sentence at all, spread thinner.
     */
    const claim = pinnedClaimFor('isolation-guard-distribution')
    const counts = isolationCounts()

    expect(claim.measure).not.toBeNull()
    expect(claim.measure!({ ...counts } as MeasuredFacts)).toEqual([
      counts.scopedReads,
      counts.reads,
      counts.scopedWrites,
      counts.writes,
    ])
  })

  it('refuses a measure and a pattern that disagree about how many', () => {
    /*
      Phase 121: a rule only ever seen to agree is not a rule. A four-number
      measure against a one-capture pattern would silently check the first and
      skip three, which is precisely what the old single-number `measure` did
      to this sentence.
    */
    const verdict = claimStands(
      {
        key: 'deliberately-broken',
        file: 'nowhere',
        pattern: /(\d+) of the \d+ reads/,
        because: 'x'.repeat(240),
        measure: () => [1, 2, 3],
      },
      '7 of the 9 reads',
      { reads: 0 } as MeasuredFacts,
    )

    expect(verdict.ok).toBe(false)
    expect((verdict as { why: string }).why).toMatch(/disagree about how many/)
  })

  it('names which of several numbers drifted', () => {
    const verdict = claimStands(
      {
        key: 'deliberately-wrong',
        file: 'nowhere',
        pattern: /(\d+) of the (\d+) reads/,
        because: 'x'.repeat(240),
        measure: () => [7, 10],
      },
      '7 of the 9 reads',
      {} as MeasuredFacts,
    )

    // The second, named as the second — a failure that cannot say which number
    // moved is a failure somebody fixes by changing the wrong one.
    expect((verdict as { why: string }).why).toMatch(/number 2 of this sentence should be 10/)
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
