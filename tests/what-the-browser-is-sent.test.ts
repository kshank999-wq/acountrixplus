import { describe, expect, it } from 'vitest'
import {
  SERVER_ONLY_PACKAGES,
  bundleLeaks,
  describeLeak,
  projectTree,
  valueImports,
  type SourceTree,
} from '@/modules/source/client-bundle'

/**
 * What the browser is sent (Phase 192).
 *
 * ## The defect
 *
 * `npm run build` failed from **Phase 183 to Phase 192** — eight phases — on
 * four lines that named Node built-ins and not the import that reached for
 * them:
 *
 * ```
 * Module not found: Can't resolve 'fs' / 'net' / 'tls' / 'perf_hooks'
 * ```
 *
 * One edge caused it. Phase 183 gave `document-render.tsx` — the renderer the
 * client designer and the client-facing page share — a **value** import of
 * `selectTeam` from `modules/studio/team.ts`, which imports `@/db`, which
 * imports `postgres`. Everything behind that edge was pulled toward the
 * browser.
 *
 * Measured rather than reasoned about: a worktree at Phase 189 was built and
 * failed identically, and `git log -S` dates the import to Phase 183.
 *
 * ## Why the loop missed it
 *
 * Every phase ran `tsc --noEmit` and `vitest`. **Neither bundles for a
 * browser.** A type-only question cannot see a server/client boundary, and a
 * Node test runner has `fs`. CI runs `npm run build` and would have said so;
 * nothing in the inner loop did, so eight phases of work went past a
 * repository that did not compile.
 *
 * This file is the inner loop learning the question. The build is still the
 * authority — it catches what a scan cannot — but it takes tens of seconds and
 * its message names the symptom; this takes milliseconds and names the chain.
 */

describe('no client component reaches the server', () => {
  it('finds nothing, and says exactly what it would say if it did', () => {
    const leaks = bundleLeaks()

    expect(
      leaks.map(describeLeak).join('\n\n'),
      'A `use client` file imports server-only code. Everything behind that ' +
        'import is bundled for the browser, and `npm run build` fails on a ' +
        'Node built-in rather than on the import. Break the chain by moving ' +
        'the value this component needs into a module that does not import ' +
        '`@/db` — `modules/studio/team-render.ts` is the worked example.',
    ).toBe('')
  })

  it('has entrypoints to scan, so an empty answer means something', () => {
    /*
      Phase 126's rule. `bundleLeaks()` returning nothing is only reassuring if
      it looked at anything — a resolver that silently found no files would
      pass the test above forever.
    */
    const clients = projectTree()
      .files()
      .filter((file) => /^\s*['"]use client['"]/.test(projectTree().read(file)))

    expect(clients.length).toBeGreaterThan(80)
  })
})

describe('the scan says no when it should', () => {
  /** A tiny in-memory tree, so the scan can be watched failing. */
  function tree(files: Record<string, string>): SourceTree {
    return {
      files: () => Object.keys(files),
      read: (path) => files[path] ?? '',
      resolve: (spec, _from) => (spec.startsWith('@/') ? spec : null),
    }
  }

  it('catches a client component three hops from the database', () => {
    /*
      Phase 121: a check only ever seen to agree is not a check. The scan's
      whole value is that it refuses, and the only way to watch it refuse is to
      hand it a tree that should fail — which is also the shape of the real
      defect, hop for hop.
    */
    const leaks = bundleLeaks(
      tree({
        '@/designer': "'use client'\nimport { Page } from '@/page'",
        '@/page': "import { render } from '@/render'",
        '@/render': "import { selectTeam } from '@/team'",
        '@/team': "import { db } from '@/db'",
        '@/db': "import postgres from 'postgres'",
      }),
    )

    expect(leaks).toHaveLength(1)
    expect(leaks[0].entry).toBe('@/designer')
    expect(leaks[0].pkg).toBe('postgres')
    expect(leaks[0].chain).toEqual(['@/designer', '@/page', '@/render', '@/team', '@/db'])
  })

  it('stops at a server action, which is a boundary and not a dependency', () => {
    /*
      The subtlety that makes this scan usable. Next replaces every export of a
      `'use server'` file with an RPC stub, so nothing behind it ships. A first
      version missed this and reported **93** leaks where there is one — worse
      than no scan, because a check that cries wolf is a check somebody turns
      off.
    */
    const leaks = bundleLeaks(
      tree({
        '@/panel': "'use client'\nimport { save } from '@/actions'",
        '@/actions': "'use server'\nimport { db } from '@/db'",
        '@/db': "import postgres from 'postgres'",
      }),
    )

    expect(leaks).toEqual([])
  })

  it('ignores a type-only import, which compiles to nothing', () => {
    const leaks = bundleLeaks(
      tree({
        '@/a': "'use client'\nimport type { Row } from '@/db'",
        '@/b': "'use client'\nimport { type Row, type Col } from '@/db'",
        '@/db': "import postgres from 'postgres'",
      }),
    )

    // `designer.tsx` was in exactly this state and was always safe: a
    // component importing a *type* from a module that touches the database
    // ships nothing. A scan that flagged it would be wrong about the one file
    // this phase is named after.
    expect(leaks).toEqual([])
  })

  it('does catch a value imported alongside a type', () => {
    const leaks = bundleLeaks(
      tree({
        '@/a': "'use client'\nimport { selectTeam, type Row } from '@/db'",
        '@/db': "import postgres from 'postgres'",
      }),
    )

    // Which is the real shape: `import { selectTeam, type RenderedTeamMember }`
    // is what Phase 183 wrote, and the type beside the value is what made it
    // look like a type import to a reader skimming.
    expect(leaks).toHaveLength(1)
  })

  it('follows a cycle without hanging', () => {
    const leaks = bundleLeaks(
      tree({
        '@/a': "'use client'\nimport { b } from '@/b'",
        '@/b': "import { a } from '@/a'\nimport fs from 'fs'",
      }),
    )

    expect(leaks).toHaveLength(1)
  })
})

describe('reading imports', () => {
  it.each([
    ["import { a } from 'x'", ['x']],
    ["import type { a } from 'x'", []],
    ["import { type a } from 'x'", []],
    ["import { type a, type b } from 'x'", []],
    ["import { a, type b } from 'x'", ['x']],
    ["import a from 'x'", ['x']],
    ["import * as a from 'x'", ['x']],
    ["import 'x'", ['x']],
    ["import a, { type b } from 'x'", ['x']],
  ])('reads %s as %s', (source, expected) => {
    expect(valueImports(source)).toEqual(expected)
  })
})

describe('the list of what a browser may not have', () => {
  it('argues every entry, because "server-only" is a judgement', () => {
    /*
      The Phase 101 device. A bare list invites somebody to add a name because
      it felt server-ish, and the cost of a wrong entry here is a false
      refusal in everybody's test run.
    */
    for (const entry of SERVER_ONLY_PACKAGES) {
      expect(entry.because.length, `${entry.pattern} does not argue itself`).toBeGreaterThan(100)
    }
  })

  it('covers the four built-ins the build actually failed on', () => {
    const named = ['fs', 'net', 'tls', 'perf_hooks', 'postgres', 'node:crypto']

    for (const pkg of named) {
      expect(
        SERVER_ONLY_PACKAGES.some((entry) => entry.pattern.test(pkg)),
        `${pkg} is not recognised as server-only`,
      ).toBe(true)
    }
  })

  it('does not claim an ordinary dependency is server-only', () => {
    for (const pkg of ['react', 'react-dom', 'zod', 'next/link', 'drizzle-orm', 'qrcode']) {
      expect(
        SERVER_ONLY_PACKAGES.some((entry) => entry.pattern.test(pkg)),
        `${pkg} is wrongly treated as server-only`,
      ).toBe(false)
    }
  })
})
