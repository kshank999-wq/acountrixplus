import { readFileSync } from 'node:fs'
import { RegistryError } from '@/modules/errors/registry'
import type { Permission } from '@/modules/permissions'
import { callArguments, functionBody } from './gate-forms'
import { withoutComments } from './enclosing'
import { sourceFiles } from './isolation-scan'

/**
 * A read that comes back empty because the reader may not see it (spec §11, §14).
 *
 * ## What ADR 0214 asked, and the answer being no
 *
 * Phase 214 taught the audit scan to read `if (!can(ctx, 'x')) return { ok:
 * false, … }` as a gate, and nominated the risk that comes with that: a soft
 * refusal and a thrown one are not interchangeable, so *"a soft refusal whose
 * caller drops the result is a gate in name only."*
 *
 * Measured, **no caller drops one.** All nine soft refusals in `src/modules` are
 * handled — seven return `{ ok: false }` and every caller tests `.ok`, two
 * return `null` and all four callers handle it. The nominated finding set is
 * empty, which is the first time in five phases that a nomination named nothing,
 * and is worth saying out loud rather than quietly finding something else to
 * call the defect.
 *
 * ## What the measurement found instead
 *
 * `ai/retrieval.ts` holds five permission-gated reads and every one answers an
 * **absence** rather than a refusal. The file states the rule and the rule is
 * right:
 *
 * > The checks return empty rather than throwing. A context builder assembling
 * > five kinds of data for an insight should produce an insight from the four the
 * > user may see, not fail entirely because of the fifth.
 *
 * That is correct for a **supplement**: `renderVoice(null)` is `''`,
 * `draftCampaignCopy` writes "our company", and nobody is misled. It is wrong for
 * the **subject of the act**. `suggestCategory(ctx, transactionId)` is *about*
 * that transaction, so when the reader may not see it there is nothing to degrade
 * into — and both callers of `transactionContext` said:
 *
 * > That transaction was not found.
 *
 * It was found. The reader may not see it. A salesperson holds `ai:use` and not
 * `bookkeeping:view`, so a salesperson was sent looking for a transaction that
 * exists.
 *
 * Three rules land on that at once: two answers to one question (`null` means
 * *not on these books* and *not yours to see*); Phase 47, a refusal must name
 * something actionable, and "not found" tells you to do the one thing that
 * cannot work; and Phase 70, one vocabulary for a correction — which is the
 * sharpest, because five other acts in the same module answer both questions
 * separately and these two were the only ones in it with a `not_found` and no
 * `permission`. The shape of a return type had silently removed a sentence from
 * two acts.
 *
 * ## The property, which is not "no read returns empty"
 *
 * Four of the five *should* return empty. So the assertion is narrower and about
 * callers rather than reads:
 *
 * > A read whose absence a caller turns into a refusal must be able to say why it
 * > is absent.
 *
 * `DEGRADING_READS` declares the four that may legitimately come back empty, and
 * `absentRefusalDefects()` must be empty. It is computed per caller: an entry is
 * a defect if some caller refuses on its absence, **unless** the entry names a
 * `settledBy` — a discriminated read, gated on the same permission, that the
 * caller consults *first*.
 *
 * That exception is load-bearing rather than a let-off. `accountOptions`
 * returning `[]` is still ambiguous in principle, and `suggestCategory` does
 * refuse on it with "No accounts are available to choose from." But it reads
 * `transactionContext` before it, on the same permission, so by the time the
 * account list is empty the permission question has been answered and the
 * emptiness means emptiness. **Ordering is the argument**, so the register names
 * the read that must come first and the falsifier checks that it really does come
 * first — by source position, not by assertion.
 *
 * ## The eleventh form
 *
 * `ifPermitted(ctx, permission, read, fallback)`, below in `retrieval.ts`, passes
 * the permission as an **argument to a wrapper**, which Phase 214's reader does
 * not match: it looks for `requirePermission(` and `can(`. Three call sites.
 *
 * Phase 214's figures are unaffected, and that was checked rather than assumed —
 * `ifPermitted` is module-private, all three uses are read-only, and none of the
 * thirty-one functions in `OPEN_ACTS` calls it. It is recorded here because
 * exporting it would reopen the hole Phase 214 spent a phase closing.
 *
 * Nothing here touches the database or the clock.
 */

/** A permission-gated read that answers empty rather than refusing. */
export type DegradingRead = {
  /** Repository-relative path. */
  file: string
  /** The exported function. */
  symbol: string
  /** What the reader must hold for it to answer at all. */
  permission: Permission
  /**
   * The discriminated read that must settle this permission earlier in any
   * caller that refuses on this read's absence. Absent when no caller may
   * refuse on it at all.
   */
  settledBy?: string
  why: string
}

/**
 * Every read that may answer empty because the reader is not permitted.
 *
 * Four entries, measured rather than listed: these are the permission checks in
 * `src/modules` that yield an absence, and `absentRefusals()` is what says so.
 * A fifth — `transactionContext` — was in this set until Phase 215 and left it
 * by being fixed, which is the only way an entry should leave.
 */
export const DEGRADING_READS: readonly DegradingRead[] = [
  {
    file: 'src/modules/ai/retrieval.ts',
    symbol: 'accountOptions',
    permission: 'bookkeeping:view',
    settledBy: 'transactionContext',
    why:
      'The chart a categorisation may choose from. Empty is a real state — a ' +
      'company with no active accounts — so the list cannot carry the permission ' +
      'answer by itself. `suggestCategory` and `suggestRule` do refuse on it, and ' +
      'are allowed to because both read `transactionContext` first on the same ' +
      'permission: by the time this list is empty, the reader has already been ' +
      'told whether they may see bookkeeping at all.',
  },
  {
    file: 'src/modules/ai/retrieval.ts',
    symbol: 'recentTransactions',
    permission: 'bookkeeping:view',
    why:
      'Recent activity for the anomaly review, and a genuine supplement: the ' +
      'review reports what it found in what it could see. No caller refuses on ' +
      'it, and none should — "nothing unusual" is an answer.',
  },
  {
    file: 'src/modules/ai/retrieval.ts',
    symbol: 'inboxShape',
    permission: 'bookkeeping:view',
    why:
      'What the transaction inbox looks like, for a summary. Returns a shaped ' +
      'empty rather than null — zero totals, no merchants — so a prompt can ' +
      'render it without branching. Tolerated by its one caller.',
  },
  {
    file: 'src/modules/ai/retrieval.ts',
    symbol: 'companyContext',
    permission: 'crm:view',
    why:
      'The company’s own voice, for prompts that adapt to it. The clearest case ' +
      'for degrading: `renderVoice(null)` is the empty string and ' +
      '`draftCampaignCopy` writes "our company", so the copy is a little more ' +
      'generic and nobody is told anything false. Worth noting that its branch ' +
      'cannot currently fire — both callers require `proposals:manage` or ' +
      '`marketing:manage`, and every holder of either holds `crm:view` — so this ' +
      'is belt and braces rather than the only guard, which is exactly why it is ' +
      'safe for it to be silent.',
  },
]

const KEY = (file: string, symbol: string) => `${file}::${symbol}`

/** The declared reason a read may answer empty, or a refusal naming it. */
export function degradingRead(file: string, symbol: string): DegradingRead {
  const found = DEGRADING_READS.find((read) => read.file === file && read.symbol === symbol)
  if (found) return found

  throw new RegistryError({
    registry: 'DEGRADING_READS',
    key: KEY(file, symbol),
    message:
      `\`${symbol}\` in ${file} answers empty when the reader lacks a permission, and no ` +
      'entry says why that is right. An absence standing in for a refusal is how ' +
      '`suggestCategory` came to tell a salesperson that a transaction they may not see ' +
      'does not exist. Either return a discriminated read that can say which happened, ' +
      'or declare the degradation here and say what the caller does with it.',
  })
}

/** `if (!can(ctx, 'x')) return <empty>` and `ifPermitted(ctx, 'x', …, <empty>)`. */
const BARE = /if\s*\(\s*!\s*can\(\s*[\w.]+\s*,\s*'([a-z_]+:[a-z_]+)'\s*\)\s*\)\s*(return[^\n;]{0,40})/g
const WRAPPED = /\bifPermitted\(/g

export type AbsentRefusal = { file: string; symbol: string; permission: Permission }

/**
 * Every permission check in `src/modules` whose answer is an absence.
 *
 * Both forms: the bare `return null` and `ifPermitted`'s fallback argument. The
 * wrapper is read with `callArguments`, the same bracket-balancing reader Phase
 * 214 wrote once rather than four times, because `ifPermitted(ctx, 'x', async
 * () => db.select(…), [])` cannot be parsed by stopping at a bracket.
 */
export function absentRefusals(): AbsentRefusal[] {
  const found: AbsentRefusal[] = []

  for (const file of sourceFiles('src/modules')) {
    const raw = readFileSync(file, 'utf8')
    const src = withoutComments(raw)

    for (const match of src.matchAll(BARE)) {
      if (!/^return\s+(null|undefined|\[\]|\{\s*\}|0|false)/.test(match[2].trim())) continue
      found.push({
        file,
        symbol: symbolAround(src, match.index),
        permission: match[1] as Permission,
      })
    }

    for (const match of src.matchAll(WRAPPED)) {
      const open = match.index + match[0].length - 1
      const args = callArguments(src, open)
      // The declaration itself takes named parameters, not a literal permission.
      const permission = args[1]?.match(/^'([a-z_]+:[a-z_]+)'$/)?.[1]
      if (!permission) continue
      found.push({
        file,
        symbol: symbolAround(src, match.index),
        permission: permission as Permission,
      })
    }
  }

  return found
}

/** The top-level function a position sits in. */
function symbolAround(src: string, index: number): string {
  let symbol = '(top level)'
  for (const match of src.matchAll(/(?:export )?(?:async )?function\s+(\w+)/g)) {
    if (match.index > index) break
    symbol = match[1]
  }
  return symbol
}

/**
 * A declared degrading read whose absence a caller turns into a refusal without
 * the permission having been settled first.
 *
 * Must be empty. The check is per caller, and the `settledBy` exception is
 * verified by **source position** — the discriminated read has to actually come
 * first, which is the whole of the argument for letting `accountOptions` be
 * refused on.
 */
export function absentRefusalDefects(): string[] {
  const defects: string[] = []

  for (const read of DEGRADING_READS) {
    for (const file of sourceFiles('src/modules')) {
      const src = withoutComments(readFileSync(file, 'utf8'))

      for (const call of src.matchAll(
        new RegExp(`const\\s+(\\w+)\\s*=\\s*await\\s+${read.symbol}\\s*\\(`, 'g'),
      )) {
        const bound = call[1]
        const caller = symbolAround(src, call.index)
        const body = functionBody(file, caller)
        if (body === null) continue

        const refuses = new RegExp(
          `if\\s*\\(\\s*(?:!\\s*${bound}\\b|${bound}\\.length\\s*===?\\s*0)\\s*\\)\\s*\\{?\\s*return[^}]{0,220}?ok:\\s*false`,
          's',
        ).test(body)
        if (!refuses) continue

        if (!read.settledBy) {
          defects.push(
            `${KEY(read.file, read.symbol)}: ${file}::${caller} refuses on its absence, ` +
              'and the read cannot say whether it was empty or withheld',
          )
          continue
        }

        // The named read must be consulted *earlier* in the same function.
        const settledAt = body.indexOf(read.settledBy)
        const degradedAt = body.indexOf(read.symbol)
        if (settledAt < 0 || settledAt > degradedAt) {
          defects.push(
            `${KEY(read.file, read.symbol)}: ${file}::${caller} refuses on its absence, ` +
              `but does not read ${read.settledBy} first`,
          )
        }
      }
    }
  }

  return defects
}
