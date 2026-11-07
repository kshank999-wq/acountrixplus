import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  readableSource,
  scanReads,
  scanUnresolvedTables,
  scanWrites,
  sourceFiles,
} from '@/modules/source/isolation-scan'
import {
  ALL_ISOLATION_GUARDS,
  companyScopedTablesIn,
  guardFor,
  isolationGuardFor,
} from '@/modules/tenancy/isolation'
import { enclosingQuery, templateLiteralAt } from '@/modules/source/enclosing'

/**
 * What a scan cannot see (Phase 196, spec §19).
 *
 * ADR 0195 nominated the source scans as a set, because two of them had just
 * reported holes in themselves and both were found the same way — by a change
 * moving a count the wrong amount, never by anybody reading the scan. It named
 * the write census as the cheapest honest start, with the questions in order:
 * how many writes are invisible to it, are any of them unguarded, and does the
 * same gap exist on the read side.
 *
 * ## The answers
 *
 * **157 writes were invisible.** `scanWrites` recognised a key only as
 * `input.something` or a name ending in `Id`, so `eq(proposals.id,
 * proposal.id)`, `eq(x.id, id)` and `eq(x.id, placeholder)` were not reported
 * as unguarded — they were **absent from the census entirely**. It had been
 * reporting 119 of 276, which is 43%, under a sentence that reads as a total
 * and under §19's *"strong tenant isolation"* paragraph.
 *
 * **None of them was unguarded.** That is the answer that mattered and it was
 * measured before anything was widened: all 157 classify. Six stood on a guard
 * the write classifier had no word for — an id taken from a row the function
 * had already fetched under a tenant or actor scope — and those six were read
 * one at a time rather than counted. `id-from-fetched-row` is the word, the
 * read classifier has had it since Phase 150, and its own prose claimed the
 * distinction *"makes the whole narrowing of both scans possible"* while being
 * declared `appliesTo: 'read'`.
 *
 * **The read side has no hole of that shape**, and the reason is worth
 * writing down rather than being relieved about: `scanReads` matches every
 * `.from(` on a company-scoped table and never filters by key at all, so its
 * denominator was always every read. The asymmetry that produced this defect
 * is the same one `enclosing.ts` exists for — two copies of one idea, drifted,
 * and the narrower copy was the one guarding writes.
 *
 * ## What is asserted here
 *
 * Not the counts: `isolation-guards.test.ts` and `isolation-reads.test.ts`
 * carry those, and `PINNED_CLAIMS` carries the sentences built on them. What
 * is asserted here is **reach** — that no keyed write and no read on a scoped
 * table can be in the tree and outside the census. A count is a fact about
 * today; reach is the thing that was wrong, and the only assertion that would
 * have failed in Phase 195.
 */

const SCANNED = ['src/modules', 'src/app'] as const

function scopedTables(): Set<string> {
  const names = new Set<string>()
  for (const file of sourceFiles('src/db/schema')) {
    for (const table of companyScopedTablesIn(readFileSync(file, 'utf8'))) names.add(table)
  }
  return names
}

/** Every table in the schema, scoped or not — what "is a table name" means. */
function knownTables(): Set<string> {
  const names = new Set<string>()
  for (const file of sourceFiles('src/db/schema')) {
    for (const m of readFileSync(file, 'utf8').matchAll(/export const (\w+) = pgTable\(/g)) {
      names.add(m[1])
    }
  }
  return names
}

/**
 * Every `update`/`delete` that could reach a company-scoped table and name a
 * row in it.
 *
 * ## Independent along every axis, since Phase 197
 *
 * Phase 196 wrote this derivation to be independent of the scan's **key
 * value** pattern, which is what let it find that gap. It still shared two of
 * the scan's other assumptions, and Phase 197 found a gap behind each:
 *
 * | assumption shared | what it hid |
 * | --- | --- |
 * | a table is a name in the schema | 5 writes through a variable table |
 * | a key is an `eq` | 3 writes keyed only by `inArray` |
 *
 * So an independent derivation that shares one of the scan's assumptions is
 * only independent along one axis, which is this phase's lesson applied to
 * this phase's own predecessor.
 *
 * It is broad on purpose now: a table is anything that **is** a scoped schema
 * name, or is not a schema name at all and so might be a variable holding one.
 * A key is an `eq` or an `inArray` on a column that names a row. That
 * over-collects, and over-collecting is the right direction — the assertion is
 * that every site it finds is *accounted for*, in the census or in the
 * declared-unresolved register, and a site this misses is a site nothing
 * checks.
 */
function keyedWriteSites(): string[] {
  const scoped = scopedTables()
  const known = knownTables()
  const sites: string[] = []

  for (const dir of SCANNED) {
    for (const file of sourceFiles(dir)) {
      const src = readableSource(file)

      for (const m of src.matchAll(/\.(update|delete)\(\s*(\w+)\s*\)/g)) {
        const name = m[2]
        // A scoped table, or something that is not a table name at all and
        // could therefore be a variable holding one.
        if (!scoped.has(name) && known.has(name)) continue

        const span = enclosingQuery(src, m.index)
        const where = /\bwhere\(([\s\S]*)/.exec(src.slice(span.from, span.to))?.[1] ?? ''
        if (!where) continue

        /*
          Over-collecting means collecting things that are not queries:
          `cookieStore.delete(CHALLENGE_COOKIE)` and `map.delete(key)` match
          the same text, and `enclosingQuery` then finds a `where` belonging to
          the next statement down and makes one look like a keyed write.

          A drizzle write through a variable always names that variable's
          columns — `eq(table.id, …)`, `set({ … })` — so requiring the where to
          mention `name.` tells a query from a cookie without asking the scan
          what it thinks. Two false positives in `app/actions/auth.ts` found
          this, which is the over-collection working as intended.
        */
        if (!scoped.has(name) && !new RegExp(String.raw`\b${name}\.\w`).test(where)) continue

        const aimable = [
          ...where.matchAll(/(?:eq|inArray)\(\s*\w+\.(\w+)\s*,\s*([\w.]+)\s*\)/g),
        ].filter(
          ([, column, value]) =>
            (column === 'id' || /Id$/.test(column)) && !/^(ctx|actor|session)\./.test(value),
        )
        if (aimable.length === 0) continue

        sites.push(`${file}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
  }

  return sites
}

describe('the write census reaches every write that can be aimed', () => {
  it('leaves no keyed write outside itself', () => {
    /**
     * **The assertion this phase exists for.** It is not about guarding — the
     * file beside this one asserts that every write in the census has a guard
     * — it is about the census's denominator, which is the number §19's
     * paragraph is argued from.
     *
     * Derived from the schema and the source rather than from `scanWrites`'
     * own pattern, so widening or narrowing that pattern moves this
     * assertion's answer. A test that asked the scan what the scan could see
     * would have passed in every phase from 149 to 195.
     */
    const counted = new Set(scanWrites().map((write) => `${write.file}:${write.line}`))

    /*
      Or declared unresolvable, which is Phase 139's device rather than an
      escape hatch: `retention/sweep.ts` takes its table from
      `RETENTION_POLICIES` at runtime and no reading of the source resolves
      that. A site may be in the census or in that register; being in neither
      is the failure.

      Accounted-for rather than counted is also what keeps this assertion
      honest about the resolver: if `declarationOf` stopped resolving a
      variable table, those sites would move from the census into the register
      and this would still pass — so the register's own length is asserted
      below, where a move shows up.
    */
    const declared = new Set(
      scanUnresolvedTables().map((site) => `${site.file}:${site.line}`),
    )

    const missing = keyedWriteSites().filter(
      (site) => !counted.has(site) && !declared.has(site),
    )

    expect(missing).toEqual([])
  })

  it('counts a write keyed by a row it fetched, which it could not before', () => {
    /*
      The concrete shape, named by file. `lapseExpiredProposals` writes
      `eq(proposals.id, proposalId)` after reading the proposals under
      `scoped()` — Phase 195 wrote it and found the census did not move,
      because the key was then `proposal.id` and the pattern wanted
      `input.something` or a name ending in `Id`.

      Asserted on a site that exists rather than on a synthetic one, so it
      fails if somebody narrows the pattern back.
    */
    const rowKeyed = scanWrites().filter((write) => write.kind === 'id-from-fetched-row')

    expect(rowKeyed.length).toBeGreaterThan(0)
    for (const write of rowKeyed) {
      expect(write.kind, `${write.file}:${write.line}`).not.toBeNull()
    }
  })

  it('reports nothing it cannot justify', () => {
    // The one write the widened census could not justify was
    // `mintChartAccount`, whose id came from a company-filtered helper three
    // lines up rather than from its own statement. It was given a `scoped()`
    // rather than a guard entry, because the whole ordering in `guardFor`
    // prefers the guard that cannot be separated from the write.
    const unguarded = scanWrites()
      .filter((write) => write.kind === null)
      .map((write) => `${write.file}:${write.line} ${write.symbol} — ${write.why}`)

    expect(unguarded).toEqual([])
  })
})

describe('the table held in a variable', () => {
  /**
   * Phase 197. Both scans asked `tables.has(name)` and skipped everything
   * else, so a query through a variable was not reported as unguarded — it was
   * **not a query**. 5 writes and 15 reads, and the generic helper that
   * `delete`s an import's rows was two of the writes.
   *
   * The same defect Phase 196 found in the key value, one argument to the
   * left, and missed by Phase 196 for the reason everything here gets missed:
   * the scan was asked what the scan could see.
   */
  it('resolves a ternary to both of its tables', () => {
    /*
      `const table = kind === 'customer' ? customers : vendors` — the site
      counts if either branch is company-scoped, because the scan cannot know
      which runs and the guard has to hold for both. Reported under both names
      joined, so one site is one entry however many tables it could be.
    */
    const resolved = scanWrites().filter((write) => write.table.includes('|'))

    expect(resolved.length).toBeGreaterThan(0)
    for (const write of resolved) {
      expect(write.kind, `${write.file}:${write.line}`).not.toBeNull()
    }

    // The reads too, which is where most of them are.
    expect(scanReads().filter((read) => read.table.includes('|')).length).toBeGreaterThan(10)
  })

  it('resolves a loop that destructures one, which is where the deletes are', () => {
    /*
      `for (const [table, ids, label] of [[invoices, …], [bills, …]] as const)`
      in `importing/reversal.ts`, which deletes the rows an import created.
      Those two deletes were outside the census and are the reason
      `declarationOf` reads the whole iterated expression rather than the first
      line of the declaration.
    */
    const reversal = scanWrites().filter((write) => write.file.includes('importing/reversal'))

    expect(reversal.filter((write) => write.op === 'delete').length).toBeGreaterThan(1)
    for (const write of reversal) {
      expect(write.kind, `${write.file}:${write.line}`).not.toBeNull()
    }
  })

  it('names the ones it cannot resolve rather than dropping them', () => {
    /**
     * Phase 139's device. `retention/sweep.ts` takes its table from
     * `RETENTION_POLICIES` — chosen at runtime, so no reading of the source
     * resolves it — and a scan that skipped those silently would be making
     * exactly the claim this phase exists to disprove.
     *
     * Measured exactly (Phase 126), so the register cannot quietly grow: a
     * third unresolvable site means somebody added a runtime-chosen table and
     * should either declare it or make it resolvable.
     */
    const unresolved = scanUnresolvedTables()

    expect(unresolved).toHaveLength(2)
    for (const site of unresolved) {
      expect(site.file).toBe('src/modules/retention/sweep.ts')
      expect(site.op).toBe('read')
    }
  })

  it('is stateless, so two scans do not double-count it', () => {
    /*
      The first version pushed unresolved sites into a module-level array from
      inside the resolver, so calling `scanReads()` and `scanWrites()` in one
      process reported each site twice. A scan whose answer depends on what was
      called before it is worse than one that misses something — and this
      repository's whole argument for these registers is that the number can be
      trusted.
    */
    const once = scanUnresolvedTables()
    scanReads()
    scanWrites()

    expect(scanUnresolvedTables()).toEqual(once)
  })
})

describe('the writes no builder-based scan can see', () => {
  /**
   * Seven, all in `src/modules/parties/service.ts`, and found only because
   * this phase's ADR nearly claimed *"measured as none today"* without
   * measuring it.
   *
   * The party merge repoints records from a loser to a winner across tables
   * chosen at runtime from `PARTY_REFERENCES`, so it writes through
   * `tx.execute(sql`update ${sql.raw(table)} …`)` rather than a builder call.
   * That is a legitimate reason to leave the builder, and it puts those writes
   * outside `scanWrites`, which matches `.update(` and `.delete(`.
   *
   * All seven carry a `company_id` predicate. The point of this block is that
   * it is now *checked* rather than true because somebody looked in a phase
   * that happened to look — which is the condition the 157 were in.
   */
  /*
    The opening of a raw write, and then `templateLiteralAt` for the rest.

    A regex cannot take the whole literal, and the first attempt at this block
    proved it the expensive way: ``/sql`[\s\S]*?`/`` ends at the backtick
    *inside* `sql.raw(`"${ref.table}"`)`, so two correct writes were reported
    as having no tenant filter because the extracted text stopped before the
    `where`. Two false positives, in the phase about scans that cannot see.

    `templateLiteralAt` lives in `source/enclosing.ts` rather than here, which
    is that module's own rule: the thing more than one caller wants is a
    module, and the next scan to read raw SQL will want exactly this.
  */
  const RAW_WRITE_OPENS = /sql`\s*(update|delete)\b/gi

  function rawWrites(): { file: string; line: number; sql: string }[] {
    const found: { file: string; line: number; sql: string }[] = []

    for (const dir of SCANNED) {
      for (const file of sourceFiles(dir)) {
        const src = readableSource(file)
        for (const m of src.matchAll(RAW_WRITE_OPENS)) {
          const backtick = src.indexOf('`', m.index)
          found.push({
            file,
            line: src.slice(0, m.index).split('\n').length,
            sql: templateLiteralAt(src, backtick),
          })
        }
      }
    }

    return found
  }

  it('reads the whole template, not as far as the first nested backtick', () => {
    /*
      The guard on the extraction itself, because the assertion below is only
      as good as the text it reads — and a truncated read makes a *passing*
      filter check impossible to distinguish from a missing filter.

      Both of the party merge's dynamic-table writes interpolate a nested
      template for the table name, so each is a case where the naive regex
      stops early.
    */
    const nested = rawWrites().filter((write) => write.sql.includes('sql.raw('))

    expect(nested.length).toBeGreaterThan(0)
    for (const write of nested) {
      expect(write.sql, `${write.file}:${write.line}`).toMatch(/where/i)
    }
  })

  it('are where the measurement says they are', () => {
    // Measured, not bounded (Phase 126). If an eighth appears anywhere, this
    // fails and sends somebody to the assertion below rather than letting a
    // raw write arrive unexamined.
    const writes = rawWrites()

    expect(writes).toHaveLength(7)
    for (const write of writes) {
      expect(write.file, `${write.file}:${write.line}`).toBe('src/modules/parties/service.ts')
    }
  })

  it('every one filters on the acting company', () => {
    /*
      The assertion the reading produced. A raw write's tenant filter is in the
      template text, so it can be required there — and the dynamic table name,
      which is why these writes are invisible to the builder scan, is no
      obstacle to checking the predicate beside it.

      `company_id` rather than `companyId`: these are SQL strings, not drizzle
      columns, which is exactly the difference that hid them.
    */
    const unfiltered = rawWrites()
      .filter((write) => !/"company_id"\s*=\s*\$\{/.test(write.sql))
      .map((write) => `${write.file}:${write.line}`)

    expect(unfiltered).toEqual([])
  })
})

describe('the read census has no hole of that shape', () => {
  it('counts every read on a scoped table, keyed or not', () => {
    /**
     * The nomination guessed this would be answered "no, for a reason worth
     * writing down", and it is: `scanReads` never filters by key. Its
     * denominator was always every `.from(` on a company-scoped table, which
     * is why the same defect could not happen on the read side however the
     * key pattern drifted.
     *
     * Asserted rather than assumed, because "it has no key filter" is a claim
     * about a regex somebody could add one to.
     */
    const tables = scopedTables()
    const expected: string[] = []

    for (const dir of SCANNED) {
      for (const file of sourceFiles(dir)) {
        const src = readableSource(file)
        for (const m of src.matchAll(/\.from\(\s*(\w+)\s*\)/g)) {
          if (!tables.has(m[1])) continue
          expected.push(`${file}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }

    const counted = new Set(scanReads().map((read) => `${read.file}:${read.line}`))
    expect(expected.filter((site) => !counted.has(site))).toEqual([])
  })
})

describe('the guard vocabulary says where it applies', () => {
  it('declares `id-from-fetched-row` for both sides, because both stand on it', () => {
    /**
     * The register's own sentence was the evidence: it said the distinction
     * *"makes the whole narrowing of both scans possible"* under
     * `appliesTo: 'read'`, and the write classifier had no input that could
     * ever return the kind. A guard declared for one side and relied on by two
     * is the registry-with-prose device failing in the direction it is worst
     * at — the prose was right and nothing compared it to the code.
     */
    const guard = isolationGuardFor('id-from-fetched-row')

    expect(guard.appliesTo).toBe('both')
    expect(guard.because).toMatch(/both scans/)

    // Used on both sides, measured. A kind declared `both` and used by one is
    // the same defect pointing the other way.
    expect(scanReads().some((read) => read.kind === 'id-from-fetched-row')).toBe(true)
    expect(scanWrites().some((write) => write.kind === 'id-from-fetched-row')).toBe(true)
  })

  it('prefers a tenant filter over a row property when a write has both', () => {
    /*
      Ordering, asserted on the verdict directly. Most of the writes this phase
      brought into the census have a real `companyId` filter *and* a row-property
      key, and reporting them under the weaker of the two would overstate how
      much of this system rests on provenance rather than on a filter.
    */
    const both = guardFor({
      scopedInStatement: false,
      companyInStatement: true,
      conditionsArray: false,
      actorFiltered: false,
      readThenRefuse: false,
      ownerHelper: null,
      bearerToken: false,
      keyIsRowProperty: true,
      takesActorContext: true,
      exported: true,
      systemPath: false,
    })

    expect(both).toEqual({ guarded: true, kind: 'explicit-company' })

    // And on its own it is still a guard, which is what the eight writes that
    // had no word rely on.
    const alone = guardFor({
      scopedInStatement: false,
      companyInStatement: false,
      conditionsArray: false,
      actorFiltered: false,
      readThenRefuse: false,
      ownerHelper: null,
      bearerToken: false,
      keyIsRowProperty: true,
      takesActorContext: true,
      exported: true,
      systemPath: false,
    })

    expect(alone).toEqual({ guarded: true, kind: 'id-from-fetched-row' })
  })

  it('argues every guard it declares, on both sides of the system', () => {
    // The device's own floor, applied to the field this phase changed: a guard
    // that says where it applies has to say it in a way a reader can check.
    for (const guard of ALL_ISOLATION_GUARDS) {
      expect(['read', 'write', 'both'], guard.kind).toContain(guard.appliesTo)
      expect(guard.because.length, guard.kind).toBeGreaterThan(140)
    }
  })
})
