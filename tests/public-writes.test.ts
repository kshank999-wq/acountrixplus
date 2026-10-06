import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RegistryError } from '@/modules/errors/registry'
import {
  INLINE_DECIDERS,
  PUBLIC_WRITES,
  publicWriteFor,
  publicWriteStands,
} from '@/modules/tenancy/public-writes'

/**
 * Every write a stranger can reach (Phase 174).
 *
 * No database, no clock — it reads the source.
 *
 * `intake.ts` said it was "the only unauthenticated write path in the system".
 * It stopped being that when the acceptance route was written, and the
 * acceptance route says it is "the second", which stopped being true when this
 * phase added the question route. Two files each keeping a count in prose, both
 * wrong, neither wrong in a way anything could detect.
 *
 * This is the detector.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

describe('the register of public writes', () => {
  it('names a module that exists, for every entry', () => {
    // An entry pointing at a file that moved is the declaration ADR 0134 called
    // worse than a miss: it reads as coverage and is not.
    const missing = PUBLIC_WRITES.filter((entry) => !existsSync(entry.module))
    expect(missing.map((entry) => entry.module)).toEqual([])
  })

  it('argues every entry, because "the token" is not an argument', () => {
    const problems = PUBLIC_WRITES.flatMap((entry) => publicWriteStands(entry))
    expect(problems).toEqual([])
  })

  it('counts five, measured rather than bounded', () => {
    /**
     * Phase 126. The number being in a test rather than in a docstring is the
     * whole point of this file — and it earned that on the day it was written.
     *
     * The register was first written with **three** entries: intake, acceptance
     * and questions, which were the three anybody had ever mentioned in prose.
     * The scan below immediately found two more that had never been written
     * down anywhere: the unsubscribe link and the email webhook. `intake.ts`
     * said "the only", the acceptance route said "the second", Phase 174 said
     * "the third", and the answer is five.
     */
    expect(PUBLIC_WRITES).toHaveLength(5)
    expect(new Set(PUBLIC_WRITES.map((entry) => entry.module)).size).toBe(5)
  })

  it('throws on a module nobody declared, naming the ones that exist', () => {
    expect(() => publicWriteFor('src/modules/crm/proposals.ts')).toThrow(RegistryError)

    try {
      publicWriteFor('src/modules/crm/proposals.ts')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('PUBLIC_WRITES')
      expect((error as RegistryError).message).toContain('intake.ts')
    }
  })
})

describe('what the register is held against', () => {
  /**
   * Route handlers under `src/app/api` that write without an actor.
   *
   * Measured by reading the source, which is the only direction that catches
   * the case this register exists for: somebody adding a fourth public write
   * and not declaring it.
   *
   * The signal is a `POST`/`PUT`/`PATCH`/`DELETE` handler that never calls
   * `requireActor` or `requireSession`. That is a heuristic and is stated as
   * one — a handler could authenticate some other way — so the assertion below
   * is that every such route *delegates to a declared module*, not that the
   * list of routes equals the list of entries.
   */
  function unauthenticatedWriteRoutes(): string[] {
    if (!existsSync('src/app/api')) return []

    return sourceFiles('src/app/api')
      .filter((file) => file.endsWith('route.ts'))
      .filter((file) => {
        const src = readFileSync(file, 'utf8')
        const writes = /export async function (POST|PUT|PATCH|DELETE)\b/.test(src)
        const authenticates = /require(Actor|Session)|current(Actor|Session)/.test(src)
        return writes && !authenticates
      })
  }

  it('finds routes to check, so a broken scan cannot pass silently', () => {
    // The guard against a green tripwire that reads nothing. Three today: lead
    // intake, acceptance, and questions.
    expect(unauthenticatedWriteRoutes().length).toBeGreaterThanOrEqual(3)
  })

  it('has every unauthenticated write route delegating to a declared module', () => {
    /**
     * The assertion that matters. A route handler's job is the HTTP envelope;
     * the decision about whether a stranger may write belongs in a module that
     * tests can drive directly.
     *
     * So each of these routes must import from one of the declared modules —
     * which is both the check that the register is complete and the check that
     * no route is making that decision inline.
     */
     const declared = PUBLIC_WRITES.map((entry) =>
       entry.module.replace(/^src\//, '@/').replace(/\.ts$/, ''),
     )

    const undeclared = unauthenticatedWriteRoutes()
      .filter((file) => !INLINE_DECIDERS.includes(file))
      .filter((file) => {
        const src = readFileSync(file, 'utf8')
        return !declared.some((module) => src.includes(module))
      })

    expect(undeclared).toEqual([])
  })
})
