import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { RegistryError } from '@/modules/errors/registry'
import {
  declarationOf,
  enclosingSpan,
  enclosingSymbol,
  parameterNames,
  withoutComments,
  withoutStrings,
} from './enclosing'

/**
 * Where a computed gate gets the value it computes from (spec §14).
 *
 * ## The question, and the end it is asked from
 *
 * ADR 0219 found two acts whose permission depends on an argument, and nominated
 * the measurement: across the 329 acts, how many take an argument that selects
 * between gates, and *"for how many of those does the screen let one person
 * choose an option the gate will refuse them?"*
 *
 * Measured, that is the wrong end. A screen offering an option its own user will
 * be refused is a bad screen — the act still refuses, and Phase 47 already
 * requires the refusal to name something actionable. The dangerous shape is the
 * opposite: an argument the gate **believes**.
 *
 * ```ts
 * requirePermission(ctx, input.side === 'customer' ? 'crm:manage' : 'accounting:journal')
 * ```
 *
 * `sales` holds `crm:manage` and not `accounting:journal`. If `side` could say
 * `customer` while the ids named two suppliers, a salesperson would merge two
 * payables records. Nothing in the check prevents that; what prevents it is nine
 * lines down:
 *
 * ```ts
 * const table = input.side === 'customer' ? customers : vendors
 * ```
 *
 * **The same argument picks the record.** A caller who lies about the side does
 * not get the wrong gate — they get a record that does not exist. That is the
 * property, and it is a constraint rather than a check (Phase 116): there is no
 * step anybody could forget, because the lie removes the thing being acted on.
 *
 * ## So the property, and what fails it
 *
 * > When a gate is computed from a caller-supplied value, that value must also
 * > select the record the act touches.
 *
 * A site fails when the value picks the permission and something *else* picks
 * the record — the gate then answers a question about a claim nobody checked.
 * `detachDocument` passes by naming `input.subjectType` in its `where`;
 * `writeNote` passes by handing the same ref to `requireSubject`, which looks
 * the id up in that type's own table and throws if it is not there.
 *
 * Measured over the tree: **16** gates are computed from a caller-supplied
 * value and **all 16** select the record with it. Zero defects — which is the
 * second phase running to measure zero, and the reason this is a scan with a
 * falsifier rather than a repair. An invariant that holds by accident at 16
 * sites is one careless 17th from not holding, and nothing before this phase
 * would have said so.
 *
 * ## Why no register of the 16
 *
 * ADR 0219 refused a register of 236 entries because 230 would have said the
 * same thing, and the same objection applies here: twelve of these sixteen would
 * read *"the where clause names it"*. Phase 101's device requires an entry to
 * argue for itself. So the sixteen are checked by the property, and the register
 * below holds only the sites the property cannot read — where the value reaches
 * the gate through a local, so the path the scan looks for is not the path the
 * source contains. Three entries, each a different reason.
 */

/** How a computed gate came by the value it reads. */
export type GateOrigin =
  /** A parameter: whatever the caller said. Must also select the record. */
  | 'claim'
  /**
   * A local whose value comes from a parameter — a claim one name further away.
   *
   * Kept apart from `claim` because the property cannot judge these. The path the
   * gate names is the local's (`subject.manage`), and the path the record
   * selection names is the parameter's (`input.subject`), so looking for one
   * finds nothing and looking for the local's bare root finds whatever else the
   * function happens to call it — in `linkAsset`, `subject.label` inside a
   * refusal message. Either answer would be a coincidence. So these are declared
   * in `OPAQUE_GATES` and argued for, rather than measured.
   */
  | 'laundered'
  /** Read from the database inside the act, so a fact about a real row. */
  | 'record'
  /** A module-level register or an iteration over one; no caller involved. */
  | 'register'
  /** Nothing in the source declares it. Reported, never guessed (ADR 0134). */
  | 'unresolved'

export type GateRead = {
  /** The path as written: `input.subjectType`, not merely `input`. */
  path: string
  origin: GateOrigin
  /** The declaring text, for a reader to check the origin against. */
  declaration: string
  /** Times the path is named in the body outside this check. */
  elsewhere: number
}

export type ComputedGateSite = {
  file: string
  symbol: string
  expression: string
  reads: GateRead[]
}

/**
 * The sites the property cannot judge, each saying why it is sound anyway.
 *
 * Two kinds reach here. A **laundered** claim computes the permission from a
 * local that a parameter fed, so the gate names one path and the record
 * selection names another and neither search is evidence. An **unresolved** read
 * is one nothing in the source declares. Both are *unmeasured*, which is not the
 * same as safe, so both have to be argued for here rather than passed over —
 * an exclusion that excuses a site is worse than one that misses it (ADR 0134).
 *
 * Two entries, and the count is the point: a register of sixteen would be
 * boilerplate wearing a register's clothes, which is the objection ADR 0219
 * raised to its own nomination. These are the sites where a reader genuinely has
 * to be told something the source does not show.
 */
export type OpaqueGate = { file: string; symbol: string; why: string }

export const OPAQUE_GATES: readonly OpaqueGate[] = [
  {
    file: 'src/modules/studio/asset-links.ts',
    symbol: 'linkAsset',
    why:
      '`const subject = assetSubjectFor(input.subject.kind)` and then ' +
      '`requirePermission(ctx, subject.manage)`, so the path the gate names is ' +
      '`subject.manage` and the claim is `input.subject.kind`. The same ' +
      '`input.subject` goes to `subjectAssignment` on the insert, which writes ' +
      'the column belonging to that kind — and each column has its own foreign ' +
      'key, so a kind that does not match the id is refused by the database ' +
      'rather than by anything here. All five entries in `ASSET_SUBJECTS` yield ' +
      '`marketing:manage` today, so there is no privilege to gain by lying ' +
      'either; the sixth subject is the one that would differ.',
  },
  {
    file: 'src/modules/exporter/package.ts',
    symbol: 'assemble',
    why:
      '`can(ctx, section.source.permission)` inside `mayRead = (key: string) => ' +
      '{ const section = sectionFor(key) … }`, so the claim is `key` and it ' +
      'arrives at the gate as a field of the register entry that key selects. ' +
      '`sectionFor` throws for a key it does not name, and the rows that section ' +
      'contributes come from `section.source` — the same entry that supplied the ' +
      'permission. There is no id to lie about: a section is the whole of its own ' +
      'data, so choosing the permission and choosing the data are one act.',
  },
]

/**
 * The entry for a site, or a refusal.
 *
 * Throws rather than returning undefined, for the reason Phase 101 gives and
 * Phase 218 proved the hard way: the one caller of a lookup that could return
 * nothing caught the refusal and substituted a permission, and 11 acts were
 * reported to hold an authority they did not. A throw cannot be averaged.
 */
export function opaqueGate(file: string, symbol: string): OpaqueGate {
  const found = OPAQUE_GATES.find(
    (entry) => entry.file === file && entry.symbol === symbol,
  )

  if (!found) {
    throw new RegistryError({
      registry: 'OPAQUE_GATES',
      key: `${file}:${symbol}`,
      message:
        `No entry for ${symbol} in ${file}. A computed gate whose value reaches ` +
        'it through a local cannot be checked by the property — the path the ' +
        'gate names is not the path the record selection names — so it has to ' +
        'say here how the claim is tied to the record it acts on.',
    })
  }

  return found
}

/** The text inside the call whose opening bracket is at `open`. */
function balancedArgument(src: string, open: number): string {
  let depth = 0

  for (let at = open; at < src.length && at < open + 4_000; at++) {
    const char = src[at]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return src.slice(open + 1, at)
    }
  }

  return ''
}

/**
 * The argument after the first comma at depth zero.
 *
 * Not `split(',')`: every expression here contains commas inside a nested call —
 * `permissionFor(document.kind, 'manage')` — and splitting truncates it at the
 * first one. The first draft of this scan used `[^)]*` with a hand-rolled
 * nesting alternative and cut that expression at its inner quote, so 26 of 30
 * sites reported their root identifier as `permissionFor`: the resolver's own
 * name rather than the value it reads.
 */
function secondArgument(call: string): string | null {
  let depth = 0

  for (let at = 0; at < call.length; at++) {
    const char = call[at]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) return call.slice(at + 1).trim()
  }

  return null
}

const KEYWORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'typeof',
  'await',
  'void',
  'new',
])

/** Files the scan reads: the tree's own sources, as git has them. */
function sourceFiles(): string[] {
  return execSync('git ls-files "src/**/*.ts" "src/**/*.tsx"', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

/**
 * Every site where a permission is computed rather than named.
 *
 * `tenancy/context.ts` is skipped because it *declares* `requirePermission`, and
 * its signature — `requirePermission(ctx: ActorContext, permission: Permission)`
 * — matches a call-shaped pattern while being the opposite of a call site.
 */
export function computedGateSites(): ComputedGateSite[] {
  return sourceFiles()
    .filter((file) => !file.endsWith('src/modules/tenancy/context.ts'))
    .flatMap((file) => sitesInSource(file, readFileSync(file, 'utf8')))
}

/**
 * The same scan against source given to it, rather than the tree.
 *
 * Exported so the falsifier can be **seen to disagree** and not only to agree
 * (Phase 121). A scan whose only input is a tree it passes on is a scan nobody
 * has watched fail: Phase 218's reported nine defects of which eight were the
 * scan's own, and every one of those was found by checking a finding against
 * code — never by the property passing. A few lines of deliberately wrong source
 * are the cheapest version of that check, and the only one that runs every time.
 */
export function sitesInSource(file: string, source: string): ComputedGateSite[] {
  const sites: ComputedGateSite[] = []

  // Comments and string bodies both carry prose shaped like code, and both
  // blankings keep every offset, so indices are valid in all three strings.
  const bare = withoutComments(source)
  const plain = withoutStrings(bare)

  for (const call of plain.matchAll(/\b(?:requirePermission|can)\s*\(/g)) {
    const open = call.index + call[0].length - 1
    const expression = secondArgument(balancedArgument(bare, open))
    if (expression === null) continue

    // A quoted permission is Phase 213's population; a bare identifier
    // forwarded from a parameter is Phase 218's `forwarded`.
    if (/^['"]/.test(expression) || /^\w+$/.test(expression)) continue

    const symbol = enclosingSymbol(bare, call.index)
    if (!symbol) continue

    sites.push({
      file,
      symbol,
      expression,
      reads: readsOf(plain, call.index, open, symbol, expression),
    })
  }

  return sites
}

/**
 * Whether a local's declaration gets its value from one of the parameters.
 *
 * `const subject = assetSubjectFor(input.subject.kind)` is a local, and calling
 * it a register would be the comfortable answer and the wrong one: the value in
 * it is still whatever the caller said, one name further away. A claim laundered
 * through a local has to stay a claim, or the property passes it for free —
 * `linkAsset` names `subject` again two lines down, on `subject.label`, in a
 * refusal message. That would have read as "the value selects the record" when
 * what it selects is a noun in a sentence.
 */
function namesAParameter(declaration: string, parameters: string[]): boolean {
  const rhs = declaration.slice(declaration.indexOf('=') + 1)

  return [...rhs.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)].some((found) =>
    parameters.includes(found[1]),
  )
}

/**
 * Every name bound as a parameter at this point: the function's, and any
 * arrow's it sits inside.
 *
 * `parameterNames` answers for the declared function, and a check is often not
 * written there. `exporter/package.ts` decides a section's permission inside a
 * closure:
 *
 * ```ts
 * const mayRead = (key: string): boolean => {
 *   const section = sectionFor(key)
 *   if (can(ctx, section.source.permission)) return true
 * ```
 *
 * `enclosingSymbol` says `assemble`, whose parameters are `ctx` and `opts`, so
 * `key` looked like nothing and `section` read as a register constant. It is
 * neither: it is a value chosen by an argument, one scope in. Counting only the
 * outer signature's parameters would have left that site classified by where the
 * author put a brace.
 *
 * Over-reading is the safe direction here (Phase 126): a name wrongly called a
 * claim gets checked against the property, and a claim wrongly called a constant
 * is not checked at all.
 */
function parametersInScope(plain: string, symbol: string, at: number): string[] {
  const names = new Set(parameterNames(plain, symbol))
  const { from } = enclosingSpan(plain, at)
  const head = plain.slice(from, at)

  // Arrow headers above the check: `(key: string): boolean =>`, `(subject) =>`.
  for (const arrow of head.matchAll(/\(([^()]*)\)\s*(?::[^=\n]*?)?=>/g)) {
    for (const part of arrow[1].split(',')) {
      const name = part.trim().match(/^(?:\{[^}]*\}|\[[^\]]*\]|([A-Za-z_$][\w$]*))/)?.[1]
      if (name) names.add(name)
    }
  }

  return [...names]
}

/**
 * Where a function's body begins: past its parameter list, at its opening brace.
 *
 * Balances the signature's brackets rather than looking for the first `{`, since
 * a parameter can be typed with an object literal — `opts: { asOf?: string }` —
 * and the first brace in the declaration is then inside the signature rather
 * than the start of the body.
 */
function bodyStart(plain: string, from: number, to: number): number {
  const open = plain.indexOf('(', from)
  if (open < 0 || open >= to) return from

  let depth = 0
  for (let at = open; at < to; at++) {
    const char = plain[at]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        const brace = plain.indexOf('{', at)
        return brace < 0 || brace >= to ? from : brace
      }
    }
  }

  return from
}

/** The values a gate expression reads, each with where it came from. */
function readsOf(
  plain: string,
  at: number,
  open: number,
  symbol: string,
  expression: string,
): GateRead[] {
  const parameters = parametersInScope(plain, symbol, at)
  const stripped = withoutStrings(expression)

  /*
    The body with this one check blanked out, so the check's own mention of the
    value does not count as the record selection naming it — and **starting
    after the signature**, which is the defect the falsifier caught.

    `enclosingSpan` begins at the declaration, so the parameter list was inside
    the text being searched. For a claim read through a property that was
    harmless: `input.subjectType` does not appear in `input: WriteNoteInput`. For
    a claim named directly it was not:

    ```ts
    export async function archiveThing(ctx: ActorContext, kind: string, id: string) {
      requirePermission(ctx, permissionFor(kind, 'manage'))
      await db.delete(things).where(eq(things.id, id))
    }
    ```

    `kind` occurred once more — in `kind: string`, four words from the word
    `function`. The property passed, satisfied by the parameter's own
    declaration, on an act that gates on a claim and then ignores it. Four real
    sites were being counted the same way and passed on their remaining uses, so
    the tree was right and the measurement was not.
  */
  const span = enclosingSpan(plain, at)
  const bodyFrom = bodyStart(plain, span.from, span.to)
  const checkLength = open + balancedArgument(plain, open).length + 2 - at
  const body =
    plain.slice(bodyFrom, at) + ' '.repeat(checkLength) + plain.slice(at + checkLength, span.to)

  const reads: GateRead[] = []
  const seen = new Set<string>()

  for (const found of stripped.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g)) {
    const path = found[1]
    const root = path.split('.')[0]
    if (KEYWORDS.has(root) || seen.has(path)) continue
    // A call, not a value: `permissionFor(…)` is the resolver, not what it reads.
    if (/^\s*\(/.test(stripped.slice(found.index + path.length))) continue
    seen.add(path)

    const declaration = parameters.includes(root)
      ? ''
      : (declarationOf(plain, at, root) || '')

    let origin: GateOrigin
    if (parameters.includes(root)) origin = 'claim'
    else if (!declaration) origin = 'unresolved'
    else if (/\bawait\b/.test(declaration)) origin = 'record'
    else if (namesAParameter(declaration, parameters)) origin = 'laundered'
    else origin = 'register'

    const pattern = new RegExp(`(?<![.\\w$])${path.replace(/\./g, '\\.')}(?![\\w$])`, 'g')

    reads.push({
      path,
      origin,
      declaration: declaration.replace(/\s+/g, ' ').trim(),
      elsewhere: [...body.matchAll(pattern)].length,
    })
  }

  return reads
}

/**
 * The falsifier: gates computed from a claim the act never checks.
 *
 * A site is reported when some value the gate reads is a parameter and that
 * parameter's path is named nowhere else in the function — so the caller's word
 * chose the permission and something else chose the record.
 *
 * ## A read the scan cannot place is reported too
 *
 * The second arm is the half that would otherwise rot. A gate whose value this
 * module cannot resolve is not a gate that passed: it is one nobody measured, and
 * the first version of this scan had four of them — `const [document] = await
 * db.select(…)` — which `declarationOf` could not read and so called unresolved.
 * They happened to be records. The next one might be a claim, and silence would
 * be the same answer.
 *
 * That is ADR 0134's rule applied to this scan's own blind spots: an exclusion
 * that *excuses* a site is worse than one that misses it. So an unresolved read
 * must be declared in `OPAQUE_GATES` with the reason, exactly as a laundered
 * claim must, and until it is, the suite says so.
 *
 * Sites in `OPAQUE_GATES` are excused by name, with their reason beside them.
 * Everything else has to satisfy the property in source a reader can see.
 */
export function gatesOnUncheckedClaims(sites = computedGateSites()): string[] {
  return sites.flatMap((site) => reportsOn(site, OPAQUE_GATES))
}

/**
 * What the falsifier says about one site, given a register.
 *
 * One definition, so `staleOpaqueGates` can ask the same question with an entry
 * removed instead of approximating it. Two copies of this would be two things
 * that drift, which is the argument `enclosing.ts` makes for existing at all.
 */
export function reportsOn(
  site: ComputedGateSite,
  register: readonly OpaqueGate[] = OPAQUE_GATES,
): string[] {
  if (register.some((entry) => entry.file === site.file && entry.symbol === site.symbol)) {
    return []
  }

  const defects: string[] = []

  const claims = site.reads.filter((read) => read.origin === 'claim')
  if (claims.length > 0 && !claims.some((claim) => claim.elsewhere > 0)) {
    defects.push(
      `${site.file}:${site.symbol} gates on \`${site.expression}\`, and ` +
        `${claims.map((claim) => `\`${claim.path}\``).join(', ')} chooses the permission ` +
        'without choosing the record. Use the same value to select what the act ' +
        'touches, validate it against that record, or declare it in ' +
        'OPAQUE_GATES with the reason.',
    )
  }

  const laundered = site.reads.filter((read) => read.origin === 'laundered')
  if (laundered.length > 0) {
    defects.push(
      `${site.file}:${site.symbol} gates on \`${site.expression}\`, whose value ` +
        `reaches it through ${laundered.map((read) => `\`${read.path}\``).join(', ')} ` +
        'from a parameter. The property cannot judge that — the gate names the ' +
        'local and the record selection names the argument — so declare in ' +
        'OPAQUE_GATES how the claim is tied to the record it acts on.',
    )
  }

  const unresolved = site.reads.filter((read) => read.origin === 'unresolved')
  if (unresolved.length > 0) {
    defects.push(
      `${site.file}:${site.symbol} gates on \`${site.expression}\`, and nothing ` +
        `in the source declares ${unresolved.map((read) => `\`${read.path}\``).join(', ')}. ` +
        'This scan cannot tell whether that is a record or a claim, so it is ' +
        'unmeasured rather than safe: declare it in OPAQUE_GATES with the reason, ' +
        'or write the declaration somewhere `declarationOf` can read it.',
    )
  }

  return defects
}

/**
 * Entries that excuse nothing.
 *
 * The register's own staleness check, and it asks the strict version of the
 * question: not *does that site still exist* but **would the falsifier report it
 * if the entry were gone**. An entry whose site the property now passes on its
 * own is an exclusion nobody is checking, which is the thing ADR 0134 said is
 * worse than a gap — and it is the mistake this phase made while writing this
 * register. Two of the first three entries excused sites the scan never
 * reported: one because `can` sat inside a closure whose parameter the scan
 * could not see, one because it was an iteration over a register and never a
 * claim at all. Both would have sat here reading like findings.
 *
 * Checked by removing the entry and re-running the falsifier against that site
 * alone, so the register cannot drift from what it is for.
 */
export function staleOpaqueGates(sites = computedGateSites()): string[] {
  const stale: string[] = []

  for (const entry of OPAQUE_GATES) {
    const site = sites.find(
      (one) => one.file === entry.file && one.symbol === entry.symbol,
    )

    if (!site) {
      stale.push(`${entry.file}:${entry.symbol} is in OPAQUE_GATES and computes no gate.`)
      continue
    }

    const withoutEntry = OPAQUE_GATES.filter((one) => one !== entry)
    if (reportsOn(site, withoutEntry).length === 0) {
      stale.push(
        `${entry.file}:${entry.symbol} is in OPAQUE_GATES and the property passes it ` +
          'without the entry. Remove it: an exclusion that excuses nothing still ' +
          'reads like a reason somebody checked.',
      )
    }
  }

  return stale
}
