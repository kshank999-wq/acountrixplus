/**
 * Which function a line of source is inside (Phase 140).
 *
 * ## NOT WIRED YET — and it never will be
 *
 * Nothing in `src/` calls this and nothing should: it reads source text, and
 * the four scanners that drive the currency registries are the callers. It
 * lives in `src/modules` rather than beside them because four test files each
 * held their own copy of it, all four copies were wrong in the same way, and a
 * thing four callers share is a module.
 *
 * ## The defect
 *
 * Every one of those copies was this:
 *
 * ```ts
 * const matches = [...src.slice(0, index).matchAll(/(?:export )?(?:async )?function (\w+)/g)]
 * return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
 * ```
 *
 * The pattern is not anchored, so **the word `function` in a sentence counts**.
 * `src/modules` contains 85 mid-line occurrences of the keyword and every one of
 * them is prose. Two of them sit between the top of a function and a place money
 * is posted:
 *
 * ```
 * receivables/service.ts:567    // A function that accepts an executor has to use it …
 * receivables/customer-credit.ts:180   * since — while this function converted both sides …
 * ```
 *
 * So seven posting sites in `createInvoice` and `applyCredit` were attributed to
 * functions named **`that`** and **`converted`**.
 *
 * ## Why nothing noticed for thirteen phases
 *
 * `LEDGER_POSTINGS` was written from the scanner's output. It therefore contains
 * entries named `that` and `converted`, and `ledgerPostingFor` throws today if
 * you ask it about `createInvoice` — the function that raises every invoice in
 * the system.
 *
 * The test that should have caught it is this one, in `ledger-postings.test.ts`:
 *
 * > *keeps every declaration pointing at a function that still posts*
 *
 * It compares the declarations against the scan. Both sides come from the same
 * broken measurement, so it agrees with itself and always will. That is Phase
 * 121's rule exactly — **a check only ever seen to agree is not a check** — and
 * this is the sharpest instance of it in the codebase: not a check that happens
 * never to have disagreed, but one that *cannot*.
 *
 * ## The reach it spoils
 *
 * Broadened to every `…Cents:` assignment in `src/modules` — 2,402 of them — the
 * two scanners disagree on 126, across **seventeen** invented names: `has`,
 * `exists`, `the`, `as`, `that`, `to`, `holds`, `with`, `whose`, `of`, `is`,
 * `never`, `converted`, `nobody`, `rather`, `a`, `in`. The two that reached a
 * registry are the ones the current narrowings happen to touch, not the extent
 * of the fault. Widen any of the four scanners by a line and more arrive.
 *
 * `comparable-sums.test.ts` is the one that stings. ADR 0134 replaced a
 * fixed-line window with an enclosing-function boundary precisely because the
 * window leaked and excused a real defect — and the boundary it replaced it with
 * is one sentence away from naming the wrong function.
 *
 * ## Why a shared module rather than four fixed copies
 *
 * A constraint beats a check (Phase 116). Four copies of a fixed function is
 * four things that can drift apart again, and the next scanner makes five. One
 * module, tested against the two comments that actually caused this, is the only
 * version of this fix that closes the class rather than the instance.
 */

/**
 * Source with comments blanked out, preserving every byte offset.
 *
 * Offsets have to survive: callers slice by index and report line numbers, and a
 * scanner that renumbers the file it is describing is worse than one that misses
 * things. So comment bodies become spaces rather than disappearing, and newlines
 * inside block comments are kept.
 */
export function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (line, indent: string) => indent + ' '.repeat(line.length - indent.length))
}

/**
 * The top-level function a character offset sits inside.
 *
 * Two rules, and each of them is one of the two things the broken version got
 * wrong:
 *
 * 1. **Anchored to the start of a line.** A declaration in this codebase is
 *    always at column zero; the word in a sentence never is. That alone fixes
 *    every one of the 126 misattributions.
 * 2. **Comments blanked first.** Belt and braces, for the case the first rule
 *    misses: a block comment whose continuation line happens to begin `function`
 *    after the leading ` * ` is stripped, and so is a `//` comment at column
 *    zero.
 *
 * Requiring the opening `(` is the third rule and it is about nested functions
 * rather than prose: an inner declaration is indented, so it is already excluded
 * by anchoring, and a site inside one is attributed to the outer function —
 * which is what a registry keyed by top-level symbol wants.
 */
export function enclosingSymbol(src: string, index: number): string {
  const before = withoutComments(src.slice(0, index))
  const matches = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)]

  return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
}

/**
 * The span of source the top-level function containing `index` occupies.
 *
 * The same reading as `enclosingSymbol`, handed back as offsets for the callers
 * that want the body rather than the name. `comparable-sums.test.ts` bounds its
 * currency window this way — ADR 0134 put it there deliberately, replacing a
 * fixed-line window that leaked past a function boundary and excused a real
 * defect — and it had its own unanchored copy of the boundary reader.
 */
export function enclosingSpan(src: string, index: number): { from: number; to: number } {
  const blanked = withoutComments(src)
  const starts = [...blanked.matchAll(/^(?:export )?(?:async )?function \w+\(/gm)].map(
    (match) => match.index,
  )

  return {
    from: starts.filter((start) => start <= index).pop() ?? 0,
    to: starts.find((start) => start > index) ?? src.length,
  }
}

/**
 * Does this source declare `symbol` as a top-level function?
 *
 * The other half of the repair, and the half that makes the class impossible
 * rather than fixing two names. A registry keyed by `file:symbol` can now be
 * asked whether its keys are real, instead of being compared against the scan
 * that produced them.
 */
export function declaresFunction(src: string, symbol: string): boolean {
  return new RegExp(`^(?:export )?(?:async )?function ${symbol}\\(`, 'm').test(src)
}

/**
 * The span of the single chained query expression containing `index`.
 *
 * ## Why a third boundary, when there is already a function one
 *
 * `enclosingSpan` replaced a fixed-line window because the window leaked past a
 * function boundary and excused a real defect (ADR 0134). Phase 152 found the
 * function boundary leaking in the same way, one level in, for a question it
 * was never the right boundary for.
 *
 * `salesTaxReturn` runs two queries. The first sums `document_tax_lines` and
 * converts each row at `invoices.exchange_rate_millionths`, which is only a
 * rate at all because of a `leftJoin(invoices, …)` in that chain. The second
 * reads `.from(invoices)`. Asked "is `invoices` in scope here?" over the
 * enclosing *function*, the answer is yes even with the join deleted — and
 * `functionalSumSql` coalesces a null rate to RATE_ONE, so deleting it turns
 * the sum silently back into the face-amount addition it was repaired from.
 *
 * Measured: with the join removed, the check bounded by the function passed.
 * Bounded by the query, it names the site.
 *
 * ## How it reads one
 *
 * Backwards to the executor the chain hangs off — `db`, a `tx`, an `exec` —
 * then forwards by bracket depth to the newline that is not followed by another
 * `.`, which is Phase 150's rule and is there for the same reason: a `.where(`
 * whose argument opens on the next line is still the same statement, and
 * anything that counts lines instead of brackets gets that wrong.
 */
export function enclosingQuery(src: string, index: number): { from: number; to: number } {
  const blanked = withoutComments(src)

  const executors = [...blanked.slice(0, index).matchAll(/\b(?:db|tx|exec|executor)\b/g)]
  const from = executors.length > 0 ? executors[executors.length - 1].index : index

  let depth = 0
  for (let at = from; at < blanked.length; at++) {
    const char = blanked[at]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === '\n' && depth === 0) {
      // `\s*`, not `[ \t]*`, and the difference is a whole line of blanks.
      // Comments are stripped to spaces with their offsets kept (Phase 141), so
      // a comment sitting between two links of the chain leaves a line that is
      // entirely whitespace — and a rule that stops at the first line not
      // beginning with `.` reads that blank line as the end of the statement.
      //
      // Measured: `salesTaxReturn` has a nine-line comment above the
      // `.leftJoin(invoices, …)` that its rate depends on, so the chain was cut
      // one link short of the join it was being asked about, and the check
      // reported the site unsound with the join right there. Skipping to the
      // next non-whitespace character is the same rule stated correctly.
      const gap = /^\s*/.exec(blanked.slice(at + 1))?.[0] ?? ''
      if (blanked[at + 1 + gap.length] !== '.') return { from, to: at }
      at += gap.length
    }
  }

  return { from, to: blanked.length }
}

/**
 * The whole template literal starting at a backtick (Phase 196).
 *
 * Here rather than in the test that wanted it, for this module's own stated
 * reason: four copies of `enclosingSymbol` drifted and the thing four callers
 * share is a module. This is the first caller, and it is in a test — but the
 * next scan to look at raw SQL will want exactly this, and a regex is what it
 * will reach for otherwise.
 *
 * ## Why a regex cannot do it
 *
 * The obvious one is ``/sql`[\s\S]*?`/``, and it is wrong on the first real
 * case in this repository. The party merge writes
 *
 * ```ts
 * sql`update ${sql.raw(`"${ref.table}"`)} set … where "company_id" = ${ctx.companyId}`
 * ```
 *
 * and a non-greedy match ends at the backtick **inside** `sql.raw(...)`. So
 * the extracted text stops before `set`, and a check looking for the tenant
 * predicate concludes there isn't one. Which is what happened: this function
 * exists because that check reported two false positives on code that was
 * correct, in the phase whose whole subject is scans that cannot see.
 *
 * A greedy match is worse — it runs to the last backtick in the file.
 *
 * ## What it does instead
 *
 * Walks the text with a stack, because a template literal and an
 * interpolation nest in each other without limit: a backtick inside `${…}`
 * opens another template, whose `${…}` may open another. Returns the text from
 * the opening backtick to its match inclusive, or to the end of the source if
 * the literal is unterminated — truncating rather than throwing, because the
 * callers are scanners reading a whole tree and one unparseable file should not
 * stop the measurement.
 *
 * Escapes are skipped as pairs, so a `` \` `` does not close anything.
 */
export function templateLiteralAt(src: string, backtickIndex: number): string {
  if (src[backtickIndex] !== '`') return ''

  // `tpl` means "inside a template's text", `expr` means "inside a `${}` or a
  // brace nested in one". Only a backtick met in `tpl` can close the literal.
  const stack: ('tpl' | 'expr')[] = ['tpl']
  let at = backtickIndex + 1

  while (at < src.length && stack.length > 0) {
    const char = src[at]

    if (char === '\\') {
      at += 2
      continue
    }

    if (stack[stack.length - 1] === 'tpl') {
      if (char === '`') {
        stack.pop()
      } else if (char === '$' && src[at + 1] === '{') {
        stack.push('expr')
        at += 2
        continue
      }
      at++
      continue
    }

    if (char === '}') stack.pop()
    else if (char === '`') stack.push('tpl')
    else if (char === '{') stack.push('expr')
    at++
  }

  return src.slice(backtickIndex, at)
}

/**
 * The text that declares an identifier, as seen from a point inside a function
 * (Phase 197).
 *
 * ## The gap this closes
 *
 * Both isolation scans recognise a table by its **name**: `.from(invoices)`
 * counts and `.from(table)` does not, because `table` is not in the schema.
 * That is not a narrowing anybody chose — it is the same defect Phase 196
 * found in the key pattern, one argument to the left, and it hides 7 writes
 * and 17 reads including two generic helpers that **delete**.
 *
 * The idiom in this repository is uniform, which is why resolving it is worth
 * doing rather than declaring:
 *
 * ```ts
 * const table = kind === 'customer' ? customers : vendors   // a local
 * function requireOwn(exec, ctx, table: OwnedTable, …)       // a parameter
 * type OwnedTable = typeof organizations | typeof contacts   // its alias
 * const table = sweep.table as never                        // unresolvable
 * ```
 *
 * ## What it returns
 *
 * The declaring text, for the caller to read table names out of — not the
 * names themselves, because this module knows nothing about the schema and
 * must not learn: it is shared by scans that each define "a table" their own
 * way.
 *
 * Searched in the order a reader would: the nearest local declaration above
 * the point, then the enclosing signature's annotation, then — once, never
 * recursively — a `type X = …` alias anywhere in the same file, because an
 * annotation naming an alias has not finished declaring anything.
 *
 * Returns `''` when nothing declares it, which is a real answer:
 * `sweep.table as never` comes from a registry and no amount of reading the
 * source resolves it. A caller that treats `''` as "no tables" would silently
 * skip those sites, so the callers here treat it as **unresolved** and say so.
 */
export function declarationOf(src: string, index: number, identifier: string): string {
  if (!/^[A-Za-z_]\w*$/.test(identifier)) return ''

  const { from } = enclosingSpan(src, index)
  const head = src.slice(from, index)

  // The nearest local declaration, to the end of its line. Every one of these
  // in this repository is a single-line ternary; a declaration spanning lines
  // would resolve to its first line, which yields fewer tables rather than
  // wrong ones.
  const locals = [
    ...head.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+${identifier}\b[^\n]*`, 'g')),
  ]
  if (locals.length > 0) return locals[locals.length - 1][0]

  /*
    A loop that destructures it, with the whole iterated expression.

    `for (const [table, ids, label] of [[invoices, …], [bills, …]] as const)`
    declares `table` as much as a `const` does, and the three sites in
    `importing/reversal.ts` that **delete** through one are exactly this shape.
    Taken to the matching bracket rather than to the end of the line, because
    the array literal is the part that names the tables and it spans lines.
  */
  const loops = [
    ...head.matchAll(
      new RegExp(
        String.raw`for\s*\(\s*(?:const|let|var)\s*\[[^\]]*\b${identifier}\b[^\]]*\]\s*of\s*`,
        'g',
      ),
    ),
  ]
  if (loops.length > 0) {
    const last = loops[loops.length - 1]
    /*
      The iterated expression starts where the match ends, so its length is
      measured from there and added to there — not to the match's own start,
      which is the bug the unit test for this caught. On the real tree it
      passed anyway: the truncated text still reached `invoices`, and one
      candidate table is enough for a site to count. A test that only drives
      real input would have agreed with it.
    */
    const expression = last.index + last[0].length
    return head.slice(last.index, expression + balancedLength(head, expression))
  }

  // Otherwise an annotation: `table: typeof invoices | typeof bills` or
  // `table: OwnedTable`, in the signature this point sits inside.
  const annotation = new RegExp(String.raw`\b${identifier}\s*:\s*([^,)\n][^,)\n]*)`).exec(head)
  if (!annotation) return ''

  const annotated = annotation[0]
  if (/\btypeof\s+\w+/.test(annotated)) return annotated

  // One alias hop. `type OwnedTable = typeof organizations | typeof contacts`
  // declares the parameter as much as the parameter does.
  const alias = /:\s*(\w+)\s*$/.exec(annotated.trim())
  if (!alias) return annotated

  const declared = new RegExp(String.raw`\btype\s+${alias[1]}\s*=\s*([^\n]*)`).exec(src)
  return declared ? declared[0] : annotated
}

/**
 * How far from `start` the brackets opened there stay balanced.
 *
 * Used by `declarationOf` for a `for … of [ … ]` whose iterated expression
 * spans lines. Bounded, like `statementAt`'s walk, so one unterminated
 * expression cannot make a whole-tree scan walk the rest of the file.
 */
function balancedLength(src: string, start: number): number {
  let depth = 0

  for (let at = start; at < src.length && at < start + 4_000; at++) {
    const char = src[at]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth <= 0) return at - start + 1
    }
  }

  return Math.min(4_000, src.length - start)
}
