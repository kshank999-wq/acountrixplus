import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withoutComments, enclosingQuery } from './enclosing'
import {
  companyScopedTablesIn,
  guardFor,
  readGuardFor,
  type GuardKind,
} from '@/modules/tenancy/isolation'

/**
 * Where a read and a write stand on the tenant (Phase 187).
 *
 * ## Why this is a module and not two test files
 *
 * It was two test files. `guardedWrites()` lived in
 * `tests/isolation-guards.test.ts` since Phase 149 and the read scan in
 * `tests/isolation-reads.test.ts` since Phase 150, and the consequence is
 * precise and was measured over five phases:
 *
 * `PINNED_CLAIMS` holds twelve numbers stated in prose that a test checks
 * against a measurement, and **one it cannot** — the sentence in
 * `modules/tenancy/isolation.ts` reading *"N of the M reads, against P of the Q
 * writes"*. Nothing outside those two test files could ask for the numbers, so
 * that entry was declared with `measure: null` under Phase 139's rule: a
 * register that looked complete while covering twelve of thirteen would be
 * worse than one that names what is not wired.
 *
 * It then went stale in **every phase that touched a read** — 180, 183, 184,
 * 185 and 186 — and was corrected by hand each time. Five corrections is the
 * measured cost of the arrangement, and it is why ADR 0186 nominated this over
 * more §7 work: the debt was small and the interest was being paid in full
 * every phase.
 *
 * ## What moving it did and did not change
 *
 * Not the measurements. Every regex, every detector and every boundary below
 * is the one the test files carried, because they were right and are the
 * subject of several phases of correction — Phase 150's bracket counting
 * instead of line counting, Phase 152's `enclosingQuery`, Phase 183's
 * replacement of a fixed window with it.
 *
 * ## The two copies had drifted, and one of them was wrong
 *
 * Each file had its own `readable()`: the reads copy blanked single-quoted
 * strings, the writes copy blanked **template literals** as well.
 *
 * A first measurement compared how many `.from(` sites each found, saw 924
 * either way and no file differing, and called the divergence latent. That
 * measurement was too narrow — it counted the sites and not the **verdicts**.
 * Running the real classifier found one read that moves:
 *
 * ```
 * payables/remittance-send.ts  settledBills  from paymentApplications
 *   quotes only  -> explicit-company
 *   + templates  -> join-inherited
 * ```
 *
 * Its tenant filter is `sql`${paymentApplications.companyId} = ${companyId}``
 * — real, explicit, and inside a template literal. **A `sql`` ` `` template in
 * drizzle is the query, not a string**, so blanking it deletes a genuine
 * tenant filter from the scan's view and the read falls through to the weaker
 * guard it also happens to satisfy.
 *
 * So the unified version is the reads copy, and the writes copy's extra
 * blanking was the mistake. Measured in that direction too: keeping templates
 * changes no write's classification today, because no write expresses its
 * tenant filter in raw SQL — yet. It would have been wrong the day one did,
 * which is `enclosing.ts`' finding one level up: copies drift, and the drift
 * is only harmless until it is not.
 */

export type GuardedRead = {
  file: string
  line: number
  symbol: string
  table: string
  kind: GuardKind | null
}

export type GuardedWrite = {
  file: string
  line: number
  symbol: string
  table: string
  op: string
  kind: GuardKind | null
  why: string
}

/** The directories a scan walks. Both halves read the same tree. */
const SCANNED = ['src/modules', 'src/app'] as const

/** Every `.ts`/`.tsx` under a directory, recursively. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/**
 * Source with comments and string literals blanked, byte offsets preserved.
 *
 * Prose about a query must not be counted as one, and nor must a table name
 * inside a string. Offsets survive because callers slice by index and report
 * line numbers, which is `withoutComments`' own rule.
 *
 * Template literals are **not** blanked, deliberately. A `sql`` ` `` template is
 * the query rather than a string, and blanking it hides real tenant filters —
 * see the module docstring for the read that proves it.
 */
export function readableSource(file: string): string {
  return withoutComments(readFileSync(file, 'utf8'))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
}

/**
 * Every table in the schema that carries a `companyId`.
 *
 * One implementation, in `modules/tenancy/isolation`, since Phase 150 — the
 * scan had its own and it was wrong: the regex ran past a table's closing
 * brace into the next declaration, calling two content-addressed tables
 * tenant-scoped and missing seven that are.
 */
function companyScopedTables(): Set<string> {
  return new Set(
    companyScopedTablesIn(
      sourceFiles('src/db/schema')
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n\n'),
    ),
  )
}

/**
 * The whole chained statement starting at an offset, by bracket depth.
 *
 * **Not by lines.** The first version walked forward while lines looked like
 * continuations, and a `.where(` whose argument starts on the next line with
 * `scoped(` ended the statement early — so it reported 113 unguarded reads,
 * including `recentActivity`, which `tests/tenant-isolation.test.ts` has proved
 * isolates since Phase 122. Counting brackets cannot make that mistake.
 */
export function statementAt(src: string, from: number): string {
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

const OWNER_HELPER = /\b(load\w*Own\w*|\w*ForOwner|require\w*Owner\w*|assert\w*Own\w*)\s*\(/

/**
 * Every read from a company-scoped table, with the guard it actually has.
 *
 * ADR 0149 nominated this: a `select` that returns another company's rows is a
 * breach whether or not anything was written, and that phase measured only the
 * writes because they are the shape that can be *aimed*.
 */
export function scanReads(): GuardedRead[] {
  const tables = companyScopedTables()
  const found: GuardedRead[] = []

  for (const dir of SCANNED) {
    for (const file of sourceFiles(dir)) {
      const src = readableSource(file)

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

/**
 * Every update or delete on a company-scoped table, keyed by an id argument.
 *
 * Narrowed to writes keyed by an id the function was handed, because that is
 * the shape that can reach another tenant's row: a write whose `where` is a
 * business predicate cannot be aimed.
 *
 * The statement's span comes from `enclosingQuery` and not from a character
 * window. Phase 183 found the window: it read 600 characters between the table
 * and its `where(`, so a `.set({ … })` longer than that pushed the `where` out
 * of reach, the statement did not match the pattern **at all**, and four writes
 * were never counted — `changeStage`, `billStage`, `issueToken` and
 * `updateTeamMember`. All four were guarded, which is the only reason that was
 * a measurement defect and not a disclosure; the file whose one job is to say
 * so had never looked at them.
 */
export function scanWrites(): GuardedWrite[] {
  const tables = companyScopedTables()
  const writes: GuardedWrite[] = []

  for (const dir of SCANNED) {
    for (const file of sourceFiles(dir)) {
      const src = readableSource(file)

      for (const m of src.matchAll(/\.(update|delete)\(\s*(\w+)\s*\)/g)) {
        const [, op, table] = m
        if (!tables.has(table)) continue

        const span = enclosingQuery(src, m.index)
        const statement = src.slice(span.from, span.to)
        const where = /\bwhere\(([\s\S]*)/.exec(statement)?.[1] ?? ''
        if (!where) continue

        /*
          The read side's pattern, since Phase 196 — `[\w.]+` rather than
          `input\.\w+|\w+Id`.

          The narrow form recognised a key only as `input.something` or a name
          ending in `Id`, so `eq(proposals.id, proposal.id)`, `eq(x.id, id)`
          and `eq(x.id, placeholder)` were all invisible: not reported as
          unguarded, **absent from the census entirely**. Measured in Phase
          196, that is 138 writes against 119 counted — the census saw 46% of
          the keyed writes on company-scoped tables, and §19's "strong tenant
          isolation" paragraph is argued from it.

          Found because Phase 195 added one such write and its count did not
          move. Two copies of one idea, drifted — which is `enclosing.ts`'
          finding, one scan over, and the third time this repository has paid
          for it.
        */
        const keyed = [...where.matchAll(/eq\(\s*\w+\.\w+\s*,\s*([\w.]+)\s*\)/g)].map(
          (k) => k[1],
        )
        if (keyed.length === 0) continue

        const before = [...src.slice(0, m.index).matchAll(/^(export )?(?:async )?function (\w+)/gm)]
        if (before.length === 0) continue
        const fn = before[before.length - 1]
        const head = src.slice(fn.index, m.index)

        const verdict = guardFor({
          scopedInStatement: /scoped\(/.test(statement),
          companyInStatement: /companyId/.test(statement) || /companyId/.test(head),
          conditionsArray: /\.\.\.\(?\s*conditions/.test(statement),
          actorFiltered: /userId\s*,\s*ctx\.userId/.test(where),
          // The filter is one statement earlier and the refusal is the guard.
          readThenRefuse:
            (/userId\s*,\s*ctx\.userId/.test(head) || /scoped\(\s*ctx/.test(head)) &&
            /\bthrow\s/.test(head),
          ownerHelper: OWNER_HELPER.test(head) ? (head.match(OWNER_HELPER)?.[1] ?? null) : null,
          bearerToken: /isNull\(\s*\w+\.redeemedAt\s*\)/.test(where),
          /*
            Measured the same way `scanReads` measures it, and the prefixes are
            the same list for the same reason: `input.practiceId` is a bare
            argument wearing a dot and the caller chooses it, while
            `proposal.id` is a field of a row this function already fetched.
          */
          keyIsRowProperty: keyed.some(
            (key) =>
              key.includes('.') && !/^(input|ctx|opts|args|params|session)\./.test(key),
          ),
          takesActorContext: /ctx\s*:\s*ActorContext|\(\s*ctx\s*[,)]/.test(
            src.slice(fn.index, fn.index + 260),
          ),
          exported: fn[1] === 'export ',
          systemPath: /\/worker\//.test(file),
        })

        writes.push({
          file,
          line: src.slice(0, m.index).split('\n').length,
          symbol: fn[2],
          table,
          op,
          kind: verdict.guarded ? verdict.kind : null,
          why: verdict.guarded ? '' : verdict.why,
        })
      }
    }
  }

  return writes
}

/** How many of a set of sites stand on each guard. */
export function byGuard(sites: Array<{ kind: GuardKind | null }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const site of sites) counts[site.kind ?? 'none'] = (counts[site.kind ?? 'none'] ?? 0) + 1
  return counts
}

/**
 * The four numbers the thirteenth pinned claim is about.
 *
 * The whole reason this module exists. `isolation.ts` says *"N of the M reads,
 * against P of the Q writes"* in the entry arguing that the two halves of this
 * system are guarded differently, and until Phase 187 nothing outside two test
 * files could ask for any of the four.
 *
 * `scopedReads` and `scopedWrites` are the `scoped()` guards specifically,
 * because the sentence's point is the **asymmetry**: `scoped()` covers most
 * reads and a quarter of writes, which is a fact about how this codebase was
 * built and is not a defect in either half.
 */
export function isolationCounts(): {
  reads: number
  scopedReads: number
  writes: number
  scopedWrites: number
} {
  const reads = scanReads()
  const writes = scanWrites()

  return {
    reads: reads.length,
    scopedReads: reads.filter((read) => read.kind === 'scoped-read').length,
    writes: writes.length,
    scopedWrites: writes.filter((write) => write.kind === 'scoped-write').length,
  }
}
