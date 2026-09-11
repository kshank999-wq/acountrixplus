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
 * two scanners disagree on 126, across **twenty** invented names: `has`,
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
