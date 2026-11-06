/**
 * What a browser is asked to download (Phase 192).
 *
 * ## The defect this exists because of
 *
 * `npm run build` failed from **Phase 183 to Phase 192** — eight phases — with
 * four lines that said nothing about the cause:
 *
 * ```
 * Module not found: Can't resolve 'fs'
 * Module not found: Can't resolve 'net'
 * Module not found: Can't resolve 'tls'
 * Module not found: Can't resolve 'perf_hooks'
 * ```
 *
 * The cause was one import. Phase 183 gave `document-render.tsx` — the one
 * renderer the client designer and the client-facing page share — a **value**
 * import of `selectTeam` from `modules/studio/team.ts`, which imports `@/db`,
 * which imports `postgres`, which needs Node's sockets. Everything behind that
 * edge was pulled toward the browser: the schema, the query builder, the
 * driver.
 *
 * It was not caught because of what the loop measured. Every phase ran `tsc
 * --noEmit` and `vitest`, and **neither bundles for a browser**: a type-only
 * question cannot see a runtime boundary, and a Node test runner has `fs`. CI
 * runs `npm run build` and would have said so; nothing in the inner loop did.
 *
 * ## Why a scan and not just the build
 *
 * The build is still the authority and still runs. This exists because of what
 * it costs and what it says. It takes tens of seconds and a correct
 * environment, so it is the step that gets skipped; and its message names four
 * Node built-ins rather than the import that reached for them, so a person who
 * does run it still has to work out what happened. This names the chain:
 *
 * ```
 * designer.tsx -> document-page.tsx -> document-render.tsx
 *   -> modules/studio/team.ts -> db/index.ts -> postgres
 * ```
 *
 * Same argument as `isolation-scan`: the tree is the thing that can be wrong,
 * so the tree is the thing to measure, in the suite, in milliseconds.
 *
 * ## The one subtlety that makes this correct
 *
 * A `'use server'` file is a **boundary, not a dependency**. The bundler
 * replaces each of its exports with an RPC stub, so a client component is
 * entirely free to import a server action and nothing behind it ships. A scan
 * that missed this reported **93** leaks where there is one, which is worse
 * than no scan: a check that cries wolf is a check somebody turns off.
 *
 * `import type` is erased too, and so is a clause whose every specifier is
 * `type` — `import { type A, type B } from 'x'` emits nothing. Both are
 * ignored here for the same reason: a scan that counted them would report a
 * leak that does not exist.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sourceFiles } from './isolation-scan'

const SRC = join(process.cwd(), 'src')

/**
 * Packages a browser cannot be given, and why each is here.
 *
 * Argued rather than listed, the Phase 101 device: "server-only" is a judgement
 * about *this* application, and a bare list invites somebody to add a name
 * because it felt server-ish. Each of these either is a Node built-in or opens
 * a socket, a file or a process.
 */
export const SERVER_ONLY_PACKAGES: readonly { pattern: RegExp; because: string }[] = [
  {
    pattern: /^node:/,
    because:
      'The explicit Node prefix. Nothing with it has a browser implementation, and the bundler ' +
      'does not shim it — which is the whole point of the prefix.',
  },
  {
    pattern: /^(fs|net|tls|crypto|perf_hooks|zlib|http|https|stream|child_process|os|path)$/,
    because:
      'The same built-ins written without the prefix. Listed separately because a dependency ' +
      'deep in the tree still writes them this way, and these four — fs, net, tls, perf_hooks — ' +
      'are the exact names the build failed on for eight phases.',
  },
  {
    pattern: /^postgres$/,
    because:
      'The database driver. It opens a TCP socket, so it can never run in a page, and it is the ' +
      'thing at the end of the chain every accidental `@/db` import leads to.',
  },
  {
    pattern: /^@anthropic-ai\/sdk$/,
    because:
      'The AI client. It would also carry the API key into the bundle if it ever resolved, which ' +
      'makes this the one entry here whose failure mode is worse than a broken build.',
  },
  {
    pattern: /^web-push$/,
    because:
      'Signs VAPID payloads with a private key. Same shape as the SDK above: it belongs to the ' +
      'server because of what it holds, not only because of what it imports.',
  },
]

export type BundleLeak = {
  /** The `'use client'` file the chain starts at. */
  entry: string
  /** Every file from the entry to the one that imports the package. */
  chain: string[]
  /** The server-only package reached. */
  pkg: string
}

/**
 * The source tree, injectable so the scan itself can be tested.
 *
 * Phase 121's rule: a check only ever seen to agree is not a check. This scan's
 * whole value is that it says no, and the only way to watch it say no is to
 * hand it a tree that should fail.
 */
export type SourceTree = {
  files(): string[]
  read(path: string): string
  /** Resolves an import specifier to a file in the tree, or null for a package. */
  resolve(spec: string, from: string): string | null
}

export function projectTree(): SourceTree {
  return {
    files: () => sourceFiles(SRC),
    read: (path) => readFileSync(path, 'utf8'),
    resolve(spec, from) {
      let base: string
      if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
      else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
      else return null

      const candidates = [
        `${base}.ts`,
        `${base}.tsx`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
        base,
      ]
      for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      }
      return null
    },
  }
}

/**
 * Import specifiers that survive compilation.
 *
 * `import type { X } from` is erased, and so is `import { type X, type Y }`
 * whose every specifier is a type. Both are skipped, because counting them
 * would report a leak that does not exist — and a renderer importing a *type*
 * from a module that touches the database is perfectly safe, which is exactly
 * the case `designer.tsx` was already in.
 */
export function valueImports(source: string): string[] {
  const specs: string[] = []

  for (const match of source.matchAll(
    /import\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    if (match[1]) continue

    const clause = match[2]
    const braces = /\{([\s\S]*)\}/.exec(clause)
    const outsideBraces = clause.replace(/\{[\s\S]*\}/, '').trim()

    if (braces && outsideBraces === '') {
      const names = braces[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
      if (names.length > 0 && names.every((name) => name.startsWith('type '))) continue
    }

    specs.push(match[3])
  }

  // `import 'x'` for a side effect — a stylesheet, usually, but not always.
  for (const match of source.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) specs.push(match[1])

  return specs
}

function serverOnly(spec: string): boolean {
  return SERVER_ONLY_PACKAGES.some((entry) => entry.pattern.test(spec))
}

function isDirective(source: string, directive: 'use client' | 'use server'): boolean {
  return new RegExp(`^\\s*['"]${directive}['"]`).test(source)
}

/**
 * Every `'use client'` file whose imports reach server-only code.
 *
 * Depth-first from each entry, stopping at a `'use server'` file, which is a
 * boundary rather than a dependency. Returns the first chain found per entry:
 * a second chain from the same file is the same fix, and a list of every path
 * through the graph would bury the one a person has to act on.
 */
export function bundleLeaks(tree: SourceTree = projectTree()): BundleLeak[] {
  const leaks: BundleLeak[] = []

  for (const entry of tree.files()) {
    if (!isDirective(tree.read(entry), 'use client')) continue

    const chain = walk(tree, entry, new Set())
    if (chain) leaks.push({ entry, chain: chain.files, pkg: chain.pkg })
  }

  return leaks
}

function walk(
  tree: SourceTree,
  file: string,
  seen: Set<string>,
): { files: string[]; pkg: string } | null {
  if (seen.has(file)) return null
  seen.add(file)

  const source = tree.read(file)
  if (isDirective(source, 'use server')) return null

  for (const spec of valueImports(source)) {
    if (serverOnly(spec)) return { files: [file], pkg: spec }

    const next = tree.resolve(spec, file)
    if (!next) continue

    const deeper = walk(tree, next, seen)
    if (deeper) return { files: [file, ...deeper.files], pkg: deeper.pkg }
  }

  return null
}

/** A leak as one line somebody can act on, paths relative to the repository. */
export function describeLeak(leak: BundleLeak): string {
  const relative = leak.chain.map((path) => path.replace(`${process.cwd()}/`, ''))
  return `${relative.join('\n  -> ')}\n  -> ${leak.pkg}`
}
