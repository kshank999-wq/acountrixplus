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
    expect(READS.length).toBe(866)
    expect(by).toEqual({
      'scoped-read': 530,
      'explicit-company': 247,
      'established-above': 28,
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
