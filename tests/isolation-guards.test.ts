import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withoutComments } from '@/modules/source/enclosing'
import { RegistryError } from '@/modules/errors/registry'
import {
  companyScopedTablesIn,
  guardFor,
  ISOLATION_GUARDS,
  isolationGuardFor,
  type GuardKind,
} from '@/modules/tenancy/isolation'

/**
 * What a write stands on when it is not `scoped()` (Phase 149).
 *
 * No database, no clock — it reads the source.
 *
 * The guards are declared in the module and argued there. Which guard a given
 * write has is measured here, so an entry cannot go on being true after the
 * line that made it true is deleted.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/** Comments and string literals blanked, so prose about a write is not one. */
function readable(file: string): string {
  return withoutComments(readFileSync(file, 'utf8'))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * Every table in the schema that carries a companyId.
 *
 * One implementation, in the module, since Phase 150 — this file had its own
 * and it was wrong. The regex ran past a table's closing brace into the next
 * declaration, which falsely called two content-addressed tables tenant-scoped
 * and missed seven that are. The counts below moved because of it.
 */
function companyScopedTables(): Set<string> {
  const schema = sourceFiles('src/db/schema')
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n\n')

  return new Set(companyScopedTablesIn(schema))
}

type Write = {
  file: string
  line: number
  symbol: string
  table: string
  op: string
  kind: GuardKind | null
  why: string
}

const OWNER_HELPER = /\b(load\w*Own\w*|\w*ForOwner|require\w*Owner\w*|assert\w*Own\w*)\s*\(/

/**
 * Every update or delete on a company-scoped table, keyed by an id argument,
 * with the guard it actually has.
 *
 * Narrowed to writes keyed by an id the function was handed, because that is
 * the shape that can reach another tenant's row: a write whose `where` is a
 * business predicate cannot be aimed.
 */
function guardedWrites(): Write[] {
  const tables = companyScopedTables()
  const writes: Write[] = []

  for (const dir of ['src/modules', 'src/app']) {
    for (const file of sourceFiles(dir)) {
      const src = readable(file)

      for (const m of src.matchAll(
        /\.(update|delete)\(\s*(\w+)\s*\)([\s\S]{0,600}?)\bwhere\(([\s\S]{0,300}?)\)\s*(?:\n|;|\.returning)/g,
      )) {
        const [, op, table, mid, where] = m
        if (!tables.has(table)) continue

        const statement = mid + where
        const keyed = [...where.matchAll(/eq\(\s*\w+\.\w+\s*,\s*(input\.\w+|\w+Id)\s*\)/g)]
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

const WRITES = guardedWrites()

describe('the guards a write can stand on', () => {
  it('argues each one, and says what the scan looks for', () => {
    for (const guard of ISOLATION_GUARDS) {
      expect(guard.because.length, guard.kind).toBeGreaterThan(140)
      expect(guard.detect.length, guard.kind).toBeGreaterThan(40)
    }
  })

  it('does not call a system path company-tight', () => {
    // ADR 0134: a declaration that excuses a site is worse than one that misses
    // it. These three are legitimate and they are not tenant guards, and
    // flattening them into "guarded" is what would make the register useless.
    const loose = ISOLATION_GUARDS.filter((g) => !g.atLeastCompanyTight).map((g) => g.kind)
    expect(loose).toEqual(['bearer-credential', 'caller-established', 'system-actor'])
  })

  it('refuses a guard nobody declared', () => {
    expect(() => isolationGuardFor('trust-me')).toThrow(RegistryError)
    try {
      isolationGuardFor('trust-me')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('ISOLATION_GUARDS')
    }
  })
})

describe('every write that can be aimed at a row', () => {
  it('counts them, and counts what each one stands on', () => {
    // Measured, not bounded (Phase 126). An empty scan agrees with everything,
    // and so does one that finds six sites and calls them representative.
    //
    // The distribution is the phase's finding in one object: `scoped()` guards
    // twenty-seven of the hundred and nine, and `explicit-company` guards more
    // than twice as many.
    //
    // It was a hundred and six until Phase 150 found the table detector here
    // reading past a closing brace — seven company-scoped tables were invisible
    // to this scan, and the conclusion survived while three of the numbers did
    // not. The tables come from the module now, so both scans count the same
    // thing.
    const by: Record<string, number> = {}
    for (const write of WRITES) by[write.kind ?? 'none'] = (by[write.kind ?? 'none'] ?? 0) + 1

    expect(WRITES.length).toBe(109)
    expect(by).toEqual({
      'explicit-company': 61,
      'scoped-write': 27,
      'read-then-refuse': 9,
      'owner-helper': 4,
      'system-actor': 4,
      'caller-established': 2,
      'actor-scoped': 1,
      'bearer-credential': 1,
    })
  })

  it('has a guard for every single one', () => {
    // **The assertion the phase exists for.** A write on a company-scoped table,
    // keyed by an id somebody handed in, with nothing establishing whose row it
    // is, is a cross-tenant write — the most serious defect this system can
    // have. Today there are none, and this is what keeps that true.
    const unguarded = WRITES.filter((w) => w.kind === null).map(
      (w) => `${w.file}:${w.line} ${w.symbol} — ${w.op} ${w.table}`,
    )

    expect(unguarded).toEqual([])
  })

  it('does not rest on `scoped()` at every query, whatever the README said', () => {
    // The sentence this phase was built to check:
    //
    //   > tenant isolation rests on `scoped()` at every query
    //
    // It rests on `scoped()` at about a quarter of the writes that can be
    // aimed at a row. The sentence is corrected rather than the code, because
    // the code is right — eight guards, every one of them sound, and nothing
    // that recorded which was which.
    const scoped = WRITES.filter((w) => w.kind === 'scoped-write').length

    expect(scoped).toBeLessThan(WRITES.length / 2)
    expect(new Set(WRITES.map((w) => w.kind)).size).toBe(8)
  })

  it('uses every guard it declares, so none is kept for a case that never arises', () => {
    // The other direction. A guard nothing uses is a rule written for a
    // situation somebody imagined, and it would quietly start excusing a real
    // site the day the scan widened.
    const used = new Set(WRITES.map((w) => w.kind))
    // It has already earned its keep: `parent-scoped` was a tenth guard until
    // this line reported it as used by nothing. It was `read-then-refuse` with
    // the refusal one table up, and a distinction the measurement collapses is
    // not a distinction.
    //
    // `conditions-array` is exempt because it is a **read** guard — the trial
    // balance and the ledger detail assemble their scope into a list — and this
    // scan looks only at writes. Exempting it here rather than deleting it is
    // the honest option, and the exemption is named rather than silent.
    const unused = ISOLATION_GUARDS.map((g) => g.kind).filter(
      (kind) => !used.has(kind) && kind !== 'conditions-array',
    )

    expect(unused).toEqual([])
  })
})

describe('the two the first run of this scan called unguarded', () => {
  it('sees a filter on the acting user, which is stricter than the company', () => {
    // `revokeDevice` and `renameDevice` filter `devices.userId = ctx.userId`, so
    // a colleague in the same company cannot rename your phone. The first
    // version of this scan looked for `companyId` and reported both as
    // unguarded — the tightest rule in the codebase, invisible to a check
    // shaped like the loosest one. Eleventh instance of that family.
    const devices = WRITES.filter((w) => w.file.endsWith('mobile/devices.ts'))

    expect(devices.length).toBeGreaterThan(1)
    expect(devices.some((w) => w.kind === 'actor-scoped')).toBe(true)
  })

  it('would have reported them as company-scoped if it only looked for companyId', () => {
    // A check seen to disagree (Phase 121), against the version that was wrong.
    const src = readable('src/modules/mobile/devices.ts')
    const rename = src.slice(src.indexOf('function renameDevice'))

    expect(/companyId/.test(rename.slice(0, 500))).toBe(false)
    expect(/userId\s*,\s*ctx\.userId/.test(rename.slice(0, 500))).toBe(true)
  })
})

describe('the guards that depend on something further away', () => {
  it('keeps the caller-established helpers where their callers can be read', () => {
    // The weakest guard, and the test that keeps it honest. `recordPostedRate`
    // is module-private. `touchDevice` is exported and safe only because its
    // one caller passes an id an authenticated session established — a property
    // of the call site, so the call sites are named here.
    const posting = readFileSync('src/modules/ledger/posting.ts', 'utf8')
    expect(posting).toMatch(/^async function recordPostedRate/m)
    expect(posting).not.toMatch(/^export async function recordPostedRate/m)

    const callers = sourceFiles('src')
      .filter((file) => !file.endsWith('mobile/devices.ts'))
      .filter((file) => /\btouchDevice\(/.test(readable(file)))

    expect(callers).toEqual(['src/app/api/mobile/v1/sync/route.ts'])
    expect(readable(callers[0])).toMatch(/touchDevice\(\s*session\.deviceId/)
  })

  it('keeps the system paths out of reach of an actor', () => {
    // "It is a system path" is exactly what somebody would write to excuse a
    // real one, so it is measured: these take no ActorContext at all.
    const system = WRITES.filter((w) => w.kind === 'system-actor')
    expect(system.length).toBeGreaterThan(2)

    for (const write of system) {
      expect(write.file, write.symbol).toMatch(/\/worker\//)
    }
  })
})

describe('the verdict on its own', () => {
  it('refuses a write with nothing behind it', () => {
    const verdict = guardFor({
      scopedInStatement: false,
      companyInStatement: false,
      conditionsArray: false,
      actorFiltered: false,
      ownerHelper: null,
      readThenRefuse: false,
      bearerToken: false,
      takesActorContext: true,
      exported: true,
      systemPath: false,
    })

    expect(verdict.guarded).toBe(false)
    if (!verdict.guarded) expect(verdict.why).toMatch(/nothing in it establishes whose row/)
  })

  it('prefers the guard a reader would rely on when there are two', () => {
    // A site with both a scope in the statement and an owner helper above is
    // reported under the statement, because that is the one that cannot be
    // separated from the write.
    expect(
      guardFor({
        scopedInStatement: true,
        companyInStatement: true,
        conditionsArray: false,
        actorFiltered: false,
        ownerHelper: 'loadOwnEditable',
        readThenRefuse: true,
        bearerToken: false,
        takesActorContext: true,
        exported: true,
        systemPath: false,
      }),
    ).toEqual({ guarded: true, kind: 'scoped-write' })
  })

  it('does not let a system path excuse a function that has an actor', () => {
    // The excuse that had to be checkable. A worker file is not a licence.
    const verdict = guardFor({
      scopedInStatement: false,
      companyInStatement: false,
      conditionsArray: false,
      actorFiltered: false,
      ownerHelper: null,
      readThenRefuse: false,
      bearerToken: false,
      takesActorContext: true,
      exported: true,
      systemPath: true,
    })

    expect(verdict.guarded).toBe(false)
  })
})
