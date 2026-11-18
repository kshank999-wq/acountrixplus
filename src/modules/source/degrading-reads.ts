import { readFileSync } from 'node:fs'
import { RegistryError } from '@/modules/errors/registry'
import { ROLE_NAMES, ROLE_PERMISSIONS, type Permission, type Role } from '@/modules/permissions'
import { callArguments, functionBody, permissionChecksIn } from './gate-forms'
import { withoutComments } from './enclosing'
import { sourceFiles } from './isolation-scan'

/**
 * A read that comes back empty because the reader may not see it (spec §11, §14).
 *
 * ## Phase 215 built this register and its falsifier was the weaker half
 *
 * Five permission-gated reads in `ai/retrieval.ts` answer an **absence** rather
 * than refusing. Phase 215 found that one of them, `transactionContext`, was the
 * **subject** of its act rather than a supplement, so `null` meant both *not on
 * these books* and *not yours to see* and both callers said "That transaction
 * was not found." It gave that read a discriminated result, declared the other
 * four here, and asserted this:
 *
 * > A read whose absence a caller turns into a **refusal** must be able to say
 * > why it is absent.
 *
 * That is the wrong half of the right idea. It asks about the caller that
 * refuses. **The dangerous caller is the one that answers.**
 *
 * `recentTransactions` answers `[]` without `bookkeeping:view`, and
 * `reviewAnomalies` turned that into:
 *
 *     { ok: true, findings: [], message: 'Not enough activity yet for a useful review.' }
 *
 * A clean bill of health — `ok: true` — about a company that may have ten
 * thousand transactions, handed to a salesperson who was never permitted to see
 * one. `summarizeInbox` is worse because it does not even branch: `inboxShape`
 * hands it a *shaped* empty, zero uncategorised and no merchants, and it passed
 * those zeroes to the model, which wrote a confident summary of a tidy inbox and
 * charged a provider call for it. A false statement with an author.
 *
 * Both are reachable. They are server actions, and Phase 214's own finding is
 * that a page guard does not protect an HTTP endpoint — `src/app` holds eleven
 * permission checks in three files because gates live in modules. Every act in
 * every other file of the AI module gates itself; `bookkeeping.ts` was the only
 * one that did not, and after Phase 215 two of its four acts get their answer
 * out through `transactionContext`. These two had nothing.
 *
 * And this register said so, in prose, one commit before it was false:
 *
 * > No caller refuses on it, and none should — "nothing unusual" is an answer.
 *
 * Nothing unusual is an answer only if you looked.
 *
 * ## The property, restated
 *
 * > Every caller of a degrading read must already have **established** that
 * > read's permission.
 *
 * Three ways, all checkable, and the register needs no new field for any of
 * them:
 *
 * 1. the caller checks the permission itself;
 * 2. the caller checks a permission whose holders *all* hold it — which is a
 *    statement about `ROLE_PERMISSIONS`, computed rather than claimed;
 * 3. the caller consults a discriminated subject read on the same permission
 *    **first**, which is what `settledBy` names and what source position checks.
 *
 * This absorbs both of Phase 215's separate observations. `settledBy` was arm 3.
 * The note that `companyContext`'s branch "cannot fire today, because both
 * callers require `proposals:manage` or `marketing:manage` and every holder of
 * either holds `crm:view`" was arm 2 — written as a pinned premise in a test,
 * where it was true but inert. It is now the reason the property passes, which
 * is where a premise belongs.
 *
 * `absentRefusalDefects()` is gone rather than kept beside this. Two falsifiers
 * for one question is the defect this codebase names most often, and the weaker
 * one would pass for exactly the reason that made it weak.
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
   * A discriminated subject read on the same permission that a caller may
   * consult instead of checking the permission itself — the third way of
   * establishing it. Checked by source position: it has to come first.
   */
  settledBy?: string
  why: string
}

/**
 * Every read that may answer empty because the reader is not permitted.
 *
 * Four entries, measured rather than listed: `absentRefusals()` is what says
 * these are the permission checks in `src/modules` that yield an absence. A
 * fifth, `transactionContext`, was here until Phase 215 and left by being
 * fixed, which is the only way an entry should leave.
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
      'answer by itself. `suggestCategory` refuses on it, and may, because it ' +
      'reads `transactionContext` first on the same permission: by the time this ' +
      'list is empty, the reader has already been told whether they may see ' +
      'bookkeeping at all.',
  },
  {
    file: 'src/modules/ai/retrieval.ts',
    symbol: 'recentTransactions',
    permission: 'bookkeeping:view',
    why:
      'Recent activity for the anomaly review. Phase 215 wrote here that no ' +
      'caller refuses on it "and none should — \'nothing unusual\' is an answer", ' +
      'and that was false one commit after it was written: `reviewAnomalies` ' +
      'answered `ok: true` with "Not enough activity yet for a useful review" to ' +
      'a reader who had been shown nothing. Nothing unusual is an answer only if ' +
      'you looked. The act now checks `bookkeeping:view` itself, so a short list ' +
      'is a short list.',
  },
  {
    file: 'src/modules/ai/retrieval.ts',
    symbol: 'inboxShape',
    permission: 'bookkeeping:view',
    why:
      'What the transaction inbox looks like, for a summary. Returns a *shaped* ' +
      'empty rather than null — zero totals, no merchants — which is why its ' +
      'caller never noticed: there was no falsy value to branch on, so ' +
      '`summarizeInbox` passed the zeroes to the model and published the ' +
      'answer. A shaped empty is the hardest absence to catch, because it looks ' +
      'exactly like data. The act now checks `bookkeeping:view` itself.',
  },
  {
    file: 'src/modules/ai/retrieval.ts',
    symbol: 'companyContext',
    permission: 'crm:view',
    why:
      'The company’s own voice, for prompts that adapt to it, and the one read ' +
      'here that degrades correctly: `renderVoice(null)` is the empty string and ' +
      '`draftCampaignCopy` writes "our company", so the copy is a shade more ' +
      'generic and nobody is told anything false. Its callers establish the ' +
      'permission by implication rather than by checking it — every holder of ' +
      '`proposals:manage` or `marketing:manage` holds `crm:view` — which Phase ' +
      '215 noticed and pinned as a premise, and which is now the reason this ' +
      'entry passes.',
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
      'entry says why that is right. An absence standing in for data is how `reviewAnomalies` ' +
      'came to report a clean bill of health to somebody who had been shown nothing. Either ' +
      'return a discriminated read that can say which happened, or declare the degradation ' +
      'here — and make sure every caller establishes the permission first.',
  })
}

/** `if (!can(ctx, 'x')) return <empty>` and `ifPermitted(ctx, 'x', …, <empty>)`. */
const BARE = /if\s*\(\s*!\s*can\(\s*[\w.]+\s*,\s*'([a-z_]+:[a-z_]+)'\s*\)\s*\)\s*(return[^\n;]{0,40})/g
const WRAPPED = /\bifPermitted\(/g

export type AbsentRefusal = { file: string; symbol: string; permission: Permission }

const holdersOf = (permission: Permission): Role[] =>
  ROLE_NAMES.filter((role) =>
    (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission),
  )

/**
 * Every holder of `narrow` also holds `wide`, so checking `narrow` settles
 * `wide`.
 *
 * Computed from `ROLE_PERMISSIONS` rather than asserted, which is the whole
 * point: `draftCampaignCopy` never checks `crm:view`, and the reason that is
 * safe is a fact about the role table that changes when the role table does.
 */
export function establishedByImplication(narrow: Permission, wide: Permission): boolean {
  if (narrow === wide) return true

  const narrowHolders = holdersOf(narrow)
  if (narrowHolders.length === 0) return false

  const wideHolders = new Set(holdersOf(wide))
  return narrowHolders.every((role) => wideHolders.has(role))
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
 * Every permission check in `src/modules` whose answer is an absence.
 *
 * Both forms: the bare `return null` and `ifPermitted`'s fallback argument. The
 * wrapper is the eleventh form a permission check can take in this codebase and
 * Phase 214's gate reader does not see it, which is why it is read here.
 */
export function absentRefusals(): AbsentRefusal[] {
  const found: AbsentRefusal[] = []

  for (const file of sourceFiles('src/modules')) {
    const src = withoutComments(readFileSync(file, 'utf8'))

    for (const match of src.matchAll(BARE)) {
      if (!/^return\s+(null|undefined|\[\]|\{\s*\}|0|false)/.test(match[2].trim())) continue
      found.push({
        file,
        symbol: symbolAround(src, match.index),
        permission: match[1] as Permission,
      })
    }

    for (const match of src.matchAll(WRAPPED)) {
      const args = callArguments(src, match.index + match[0].length - 1)
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

/** Does this function body establish `read.permission` before trusting the read? */
function establishes(body: string, read: DegradingRead): boolean {
  const checked = permissionChecksIn(body).literal

  // 1. and 2. — the permission itself, or one whose holders all hold it.
  if (checked.some((permission) => establishedByImplication(permission, read.permission))) {
    return true
  }

  // 3. — a discriminated subject read on the same permission, consulted first.
  if (read.settledBy) {
    const settled = body.indexOf(read.settledBy)
    const degraded = body.indexOf(read.symbol)
    if (settled > -1 && settled < degraded) return true
  }

  return false
}

/**
 * Callers that trust a degrading read without having established its
 * permission.
 *
 * Must be empty. This is the property Phase 215 should have asserted: it covers
 * the caller that refuses on an absence *and* the caller that answers on one,
 * and the second is the dangerous shape — `reviewAnomalies` reporting `ok: true`
 * and `summarizeInbox` publishing a model-written summary of an inbox neither of
 * them was allowed to look at.
 */
export function unestablishedReads(): string[] {
  const gaps = new Set<string>()

  for (const read of DEGRADING_READS) {
    for (const file of sourceFiles('src/modules')) {
      const src = withoutComments(readFileSync(file, 'utf8'))

      for (const call of src.matchAll(new RegExp(`(?<![.\\w])${read.symbol}\\s*\\(`, 'g'))) {
        const caller = symbolAround(src, call.index)
        // Its own declaration is not a caller.
        if (file === read.file && caller === read.symbol) continue

        const body = functionBody(file, caller)
        if (body === null || !body.includes(`${read.symbol}(`)) continue
        if (establishes(body, read)) continue

        gaps.add(
          `${file.replace('src/', '')}::${caller} trusts ${read.symbol} without establishing ` +
            read.permission,
        )
      }
    }
  }

  return [...gaps].sort()
}
