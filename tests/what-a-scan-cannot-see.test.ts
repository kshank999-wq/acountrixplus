import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  readableSource,
  scanRawQueries,
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
import { enclosingQuery } from '@/modules/source/enclosing'

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

describe('raw SQL, in the census since Phase 198', () => {
  /**
   * The party merge repoints records across tables chosen at runtime from
   * `PARTY_REFERENCES`, so it writes through
   * ``tx.execute(sql`update ${sql.raw(table)} …`)``. A legitimate reason to
   * leave the builder, and invisible to scans that match `.from(`, `.update(`
   * and `.delete(`.
   *
   * Phase 196 asserted that the seven raw **writes** carried a tenant
   * predicate, in a test beside the census rather than in it. Phase 198
   * extended the same measurement to reads and found **four selects nobody
   * had counted** — one of them with no tenant predicate at all, nine lines
   * from a sibling that had one. A writes-only count was not merely
   * incomplete; it was incomplete in the direction that mattered.
   *
   * They are in the census now, so §19 quotes one denominator instead of a
   * number plus a test somebody has to remember to add up.
   */
  it('counts every raw statement that can reach a scoped table', () => {
    // Measured exactly (Phase 126). Eleven: four selects, four updates, three
    // deletes. A twelfth anywhere fails this and sends somebody to read it.
    const raw = scanRawQueries()

    expect(raw).toHaveLength(11)
    for (const query of raw) {
      expect(query.file, `${query.file}:${query.line}`).toBe('src/modules/parties/service.ts')
    }

    const byVerb = raw.reduce<Record<string, number>>((all, query) => {
      all[query.verb] = (all[query.verb] ?? 0) + 1
      return all
    }, {})
    expect(byVerb).toEqual({ select: 4, update: 4, delete: 3 })
  })

  it('stands every one of them on a guard', () => {
    /*
      `explicit-company` for all eleven, and the vocabulary needed no new word:
      a tenant filter written out in SQL *is* an equality on the company
      column. That is the argument for folding these into the census rather
      than registering them beside it.
    */
    const unguarded = scanRawQueries()
      .filter((query) => query.kind === null)
      .map((query) => `${query.file}:${query.line} ${query.symbol} — ${query.why}`)

    expect(unguarded).toEqual([])
    expect(new Set(scanRawQueries().map((query) => query.kind))).toEqual(
      new Set(['explicit-company']),
    )
  })

  it('is the check that bites on the predicate a behavioural test cannot see', () => {
    /**
     * `mergeParties`' collision count had no tenant predicate until Phase 198.
     * It was not a disclosure — another company's `subcontractors` row cannot
     * name this company's vendor, because `vendor_id` is a foreign key and
     * that is the cross-tenant reference Phases 170–172 made the database
     * refuse — so the count was right, and right because of a property of the
     * data rather than because of anything in the statement.
     *
     * A behavioural test for the clause was written and **deleted for passing
     * without it** (see `tests/party-merge.test.ts`). This is where the check
     * lives instead: the scan reads the predicate out of the statement, so it
     * can tell the two versions apart where no amount of data can.
     *
     * Asserted on the statement's own text rather than on a count, because a
     * count would pass if some *other* statement grew a predicate.
     */
    const collision = scanRawQueries().find(
      (query) => query.symbol === 'mergeParties' && query.verb === 'select',
    )

    expect(collision).toBeDefined()
    expect(collision?.kind).toBe('explicit-company')
    expect(collision?.table).toBe('(dynamic)')
  })

  it('reports a dynamic table as dynamic rather than guessing it', () => {
    /*
      `${sql.raw(ref.table)}` names a table this scan cannot know, and
      `isolation-scan` deliberately does not import `PARTY_REFERENCES` to find
      out: a scan that knows about one domain module will be wrong about the
      next one.

      Counted anyway — it *might* reach a scoped table, so it has to be
      guarded, which is the conservative direction and the one that cannot
      hide anything.
    */
    const dynamic = scanRawQueries().filter((query) => query.table === '(dynamic)')

    expect(dynamic).toHaveLength(4)
    for (const query of dynamic) {
      expect(query.kind, `${query.file}:${query.line}`).not.toBeNull()
    }

    // And the ones that do say resolve to real table names.
    const named = scanRawQueries().filter((query) => query.table !== '(dynamic)')
    expect(new Set(named.map((query) => query.table))).toEqual(
      new Set(['evidence_subjects', 'document_links', 'record_notes']),
    )
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
