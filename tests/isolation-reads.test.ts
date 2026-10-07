import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withoutComments } from '@/modules/source/enclosing'
import {
  ALL_ISOLATION_GUARDS,
  companyScopedTablesIn,
  readGuardFor,
  type GuardKind,
} from '@/modules/tenancy/isolation'

/**
 * What a read stands on (Phase 150, spec §14/§19).
 *
 * No database, no clock — it reads the source.
 *
 * ADR 0149 nominated this: a `select` that returns another company's rows is a
 * breach whether or not anything was written, and that phase measured only the
 * writes because they are the shape that can be aimed.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

function readable(file: string): string {
  return withoutComments(readFileSync(file, 'utf8')).replace(
    /'(?:[^'\\\n]|\\.)*'/g,
    (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`,
  )
}

/**
 * The whole chained statement starting at `.from(`, by paren depth.
 *
 * **Not by lines.** The first version of this walked forward while lines looked
 * like continuations, and a `.where(` whose argument starts on the next line
 * with `scoped(` ended the statement early — so it reported 113 unguarded
 * reads, including `recentActivity`, which `tests/tenant-isolation.test.ts` has
 * proved isolates since Phase 122. Counting brackets cannot make that mistake.
 */
function statementAt(src: string, from: number): string {
  let depth = 0
  for (let index = from; index < src.length && index < from + 4_000; index++) {
    const char = src[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === '\n' && depth === 0) {
      const indent = /^\s*/.exec(src.slice(index + 1))?.[0] ?? ''
      if (src[index + 1 + indent.length] !== '.') return src.slice(from, index)
    }
  }
  return src.slice(from, from + 4_000)
}

type Read = { file: string; line: number; symbol: string; table: string; kind: GuardKind | null }

function reads(): Read[] {
  const tables = new Set(
    companyScopedTablesIn(
      sourceFiles('src/db/schema')
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n\n'),
    ),
  )

  const found: Read[] = []

  for (const dir of ['src/modules', 'src/app']) {
    for (const file of sourceFiles(dir)) {
      const src = readable(file)

      for (const m of src.matchAll(/\.from\(\s*(\w+)\s*\)/g)) {
        if (!tables.has(m[1])) continue

        const statement = statementAt(src, m.index)
        const before = [...src.slice(0, m.index).matchAll(/^(export )?(?:async )?function (\w+)/gm)]
        const fn = before.length > 0 ? before[before.length - 1] : null
        const head = fn ? src.slice(fn.index, m.index) : ''
        const signature = fn ? src.slice(fn.index, fn.index + 300) : ''

        const where = /where\(([\s\S]*)/.exec(statement)?.[1] ?? ''
        const keys = [...where.matchAll(/eq\(\s*\w+\.\w+\s*,\s*([\w.]+)\s*\)/g)].map((k) => k[1])

        const verdict = readGuardFor({
          scopedInStatement: /scoped\(/.test(statement),
          companyInStatement: /companyId/.test(statement),
          conditionsArray: /conditions/.test(statement),
          actorFiltered: /ctx\.userId|session\.userId/.test(statement),
          joined: /innerJoin\(|leftJoin\(/.test(statement),
          establishedAbove: /companyId|scoped\(/.test(head),
          // The same id was handed to a helper that also takes the actor, in
          // either order — `loadCampaign(ctx, campaignId)` and
          // `requirePracticeOwner(input.practiceId, actor.userId, tx)` are both
          // this, and a detector that only read the first argument saw one.
          validatedAbove: keys.some((key) => {
            const bare = key.split('.').pop() ?? key
            return (
              new RegExp(`\\b\\w+\\(\\s*(ctx|actor|tx)\\s*,[^)]*\\b${bare}\\b`).test(head) ||
              new RegExp(`\\b\\w+\\([^)]*\\b${bare}\\b[^)]*,\\s*(actor|ctx)\\b`).test(head)
            )
          }),
          // A property of a row already fetched cannot be aimed by a caller —
          // but `input.practiceId` is a bare argument wearing a dot, and the
          // caller chooses it. The prefixes are the ones that mean "handed in".
          keyIsRowProperty: keys.some(
            (key) => key.includes('.') && !/^(input|ctx|opts|args|params|session)\./.test(key),
          ),
          takesActorContext: /ctx\s*:\s*ActorContext|\(\s*ctx\s*[,)]|actor\s*:/.test(signature),
          exported: fn?.[1] === 'export ',
          systemPath: /\/worker\//.test(file),
        })

        found.push({
          file,
          line: src.slice(0, m.index).split('\n').length,
          symbol: fn?.[2] ?? '(top level)',
          table: m[1],
          kind: verdict.guarded ? verdict.kind : null,
        })
      }
    }
  }

  return found
}

const READS = reads()

describe('every read from a company-scoped table', () => {
  it('has a guard, all eight hundred and sixty-six of them', () => {
    // **The assertion the phase exists for.** A select with nothing
    // establishing whose rows it returns is a breach whether or not anything
    // was written, and ADR 0149 left this half unmeasured.
    const unguarded = READS.filter((r) => r.kind === null).map(
      (r) => `${r.file}:${r.line} ${r.symbol} — from ${r.table}`,
    )

    expect(unguarded).toEqual([])
  })

  it('counts them, and what each one stands on', () => {
    // Measured, not bounded (Phase 126).
    const by: Record<string, number> = {}
    for (const read of READS) by[read.kind ?? 'none'] = (by[read.kind ?? 'none'] ?? 0) + 1

    // Eight hundred and sixty-six since Phase 151: `recordContribution` reads
    // the bank account through `bankGlAccountFor` now instead of selecting it
    // itself, so a read left this file for a gate that was already counted.
    // Eight hundred and sixty-eight since Phase 154, which added two: the
    // billing schedule a proposal carries, read per proposal when one is
    // converted and in bulk for the list. Both go through `scoped()`, which is
    // why the whole increase lands on one guard.
    //
    // Eight hundred and seventy-five since Phase 155 and `stage-invoicing.ts`,
    // which reads the schedule, the proposal, the opportunity's client and the
    // proposal's revenue account to bill a stage. All seven go through
    // `scoped()` — measured, not assumed: the length assertion fails before this
    // map is compared, so the figure below came from running it and reading the
    // diff rather than from counting call sites.
    //
    // Eight hundred and seventy-eight since Phase 156 and `stageStatesFor`, which
    // reads the stored stages to ask whether a schedule may be replaced. Three
    // reads, all `scoped-read`, measured the same way: by writing the length and
    // reading which guard the map said had grown.
    //
    // Eight hundred and eighty-three since Phase 158 and the accountant export
    // engine. Five reads, and all five land on `explicit-company` rather than
    // `scoped()` — the first time a phase's additions have gone entirely to that
    // guard, which is worth a sentence rather than letting the figure move.
    //
    // Four are in `exporter/package.ts`: the general ledger detail, its totals,
    // the orphan-line count and the draft count. Each joins `journal_lines` to
    // `journal_entries` and filters on the company column of the table the date
    // and status filters are already on — the same three filters
    // `accountBalances` applies, written a second time on purpose, because
    // §11's `detail_ties_to_balances` is what notices if the two ever stop
    // matching. The fifth is `exportHistory` over the export log.
    //
    // `companyProfile` and `taxIdentifier` are not here, and should not be: they
    // read the `companies` row itself, which carries no `company_id` because its
    // own `id` is the tenant. Measured the same way as the phases above — by
    // writing the length and reading which guard the map said had grown.
    /*
      **911 since Phase 179, and the number is the finding.** 883 was written in
      Phase 158 and did not move for twenty phases, across twenty-eight new
      reads from company-scoped tables — the longest-standing stale count this
      session found, and found only by its first complete full-suite run.

      What makes it survivable rather than serious is the assertion below it:
      every read this scan finds has to stand on a guard, and all 911 do. So
      twenty phases of reads were written correctly and counted wrongly. The
      count is what nobody maintained; the property it is attached to held.

      The distribution moved in three places and nowhere else — `scoped-read`
      +15, `explicit-company` +10, `established-above` +3 — which says the new
      reads were written in the shapes already here rather than inventing a new
      guard nobody had argued for.
    */
    expect(READS.length).toBe(911)
    expect(by).toEqual({
      'scoped-read': 557,
      'explicit-company': 262,
      'established-above': 31,
      'id-from-fetched-row': 17,
      'join-inherited': 13,
      'derives-tenant-from-row': 12,
      'caller-established': 7,
      'conditions-array': 4,
      'actor-scoped': 3,
      'validated-above': 3,
      'system-actor': 2,
    })
  })

  it('is guarded differently from the writes, which nobody had noticed', () => {
    // The finding worth keeping beside the counts. `scoped()` covers 61% of
    // reads and 25% of writes. Both are sound; they are not the same system,
    // and nothing had counted either half until Phases 149 and 150.
    const scoped = READS.filter((r) => r.kind === 'scoped-read').length
    expect(scoped / READS.length).toBeGreaterThan(0.55)
  })
})

describe('the statement this scan reads', () => {
  it('does not stop at a `where` whose argument is on the next line', () => {
    // The bug that produced 113 false positives, kept as a case. A line-based
    // walker ends the statement here; counting brackets does not.
    const src = [
      '  return db',
      '    .select()',
      '    .from(auditEvents)',
      '    .where(',
      '      scoped(ctx, auditEvents),',
      '    )',
      '    .limit(limit)',
      '',
      'const after = 1',
    ].join('\n')

    const statement = statementAt(src, src.indexOf('.from('))
    expect(statement).toMatch(/scoped\(ctx, auditEvents\)/)
    expect(statement).not.toMatch(/const after/)
  })

  it('agrees with the suite that has proved this one isolates since Phase 122', () => {
    // `recentActivity` is asserted tenant-isolated by behaviour in
    // `tests/tenant-isolation.test.ts`. A scan that called it unguarded would
    // be disagreeing with a test that actually creates two companies — and the
    // first version of this one did.
    const activity = READS.filter((r) => r.symbol === 'recentActivity')
    expect(activity.length).toBeGreaterThan(0)
    for (const read of activity) expect(read.kind).toBe('scoped-read')
  })
})

describe('the guards reads have and writes do not', () => {
  it('declares which side each guard belongs to', () => {
    for (const guard of ALL_ISOLATION_GUARDS) {
      expect(['read', 'write', 'both']).toContain(guard.appliesTo)
      expect(guard.because.length, guard.kind).toBeGreaterThan(140)
    }
  })

  it('uses every read guard it declares', () => {
    // The direction that catches a rule written for a case nobody has.
    const used = new Set(READS.map((r) => r.kind))
    const unused = ALL_ISOLATION_GUARDS.filter(
      (g) => g.appliesTo === 'read' && !used.has(g.kind),
    ).map((g) => g.kind)

    expect(unused).toEqual([])
  })

  it('keeps the one that establishes the tenant rather than confirming it', () => {
    // `settleCheckout` is the whole argument for `derives-tenant-from-row`: a
    // webhook from a payment processor, keyed by the processor's own id, with
    // no actor to filter against. Its comment says so, and this is what keeps
    // the comment true.
    const service = readable('src/modules/payments/service.ts')
    expect(service).toMatch(/export async function settleCheckout\(\s*providerCheckoutId/)
    expect(service).not.toMatch(/export async function settleCheckout\([^)]*ctx/)
  })

  it('does not call a webhook path company-tight', () => {
    const guard = ALL_ISOLATION_GUARDS.find((g) => g.kind === 'derives-tenant-from-row')
    expect(guard?.atLeastCompanyTight).toBe(false)
  })
})

describe('the verdict on its own', () => {
  const bare = {
    scopedInStatement: false,
    companyInStatement: false,
    conditionsArray: false,
    actorFiltered: false,
    joined: false,
    establishedAbove: false,
    validatedAbove: false,
    keyIsRowProperty: false,
    takesActorContext: true,
    exported: true,
    systemPath: false,
  }

  it('refuses a read with nothing behind it', () => {
    const verdict = readGuardFor(bare)
    expect(verdict.guarded).toBe(false)
    if (!verdict.guarded) expect(verdict.why).toMatch(/breach whether or not anything was written/)
  })

  it('does not let a worker path excuse a function that has an actor', () => {
    expect(readGuardFor({ ...bare, systemPath: true }).guarded).toBe(false)
  })

  it('prefers the scope in the statement when there is more than one', () => {
    expect(
      readGuardFor({ ...bare, scopedInStatement: true, joined: true, establishedAbove: true }),
    ).toEqual({ guarded: true, kind: 'scoped-read' })
  })
})
