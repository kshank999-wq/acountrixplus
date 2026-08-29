import { correction, type CorrectionKind } from '@/modules/corrections/vocabulary'
import { isSecret, maskSecret } from './visibility'

/**
 * Turning an audit row into something a person can read (spec §19).
 *
 * ## The record nobody can read
 *
 * This system has recorded audit events since Phase 3 — 224 distinct actions,
 * each with an actor, a time, and a before-and-after payload. `historyFor` and
 * `recentActivity` have existed just as long. Every caller of either is in
 * `tests/`. **No screen in the application has ever shown one.**
 *
 * Two phases spent real effort on facts that land there and nowhere else:
 *
 * - Phase 45 records a vendor's before and after on every edit, because
 *   changing a supplier's bank details is the commonest invoice-fraud vector a
 *   small business meets. "Their bank changed on the 3rd, and Dana did it" is
 *   the question that audit trail exists to answer, and nobody could ask it.
 * - Phase 70 made five corrections insist on a reason, *"so somebody reading
 *   the books later does not have to guess"* — and there was no screen for
 *   somebody reading the books later. The reason went into a JSONB column that
 *   only vitest had ever read.
 *
 * ## What this module refuses to do
 *
 * It does not machine-generate an English sentence for all 224 actions. A
 * conjugation rule over that many verbs produces sentences nobody wrote and
 * nobody checked — and gets them subtly wrong ("write_off" is not "write
 * offed") in exactly the records somebody is reading because something went
 * wrong.
 *
 * So the line is: **words we have already decided are used; words we have not
 * decided are not invented.** The five corrections have had their words decided
 * once, in `corrections/vocabulary`, and this reads them from there — so the
 * button that did the thing and the history that reports it cannot disagree,
 * which is Phase 70's rule applied to the reader instead of the writer. Every
 * other action reads as what it honestly is: its own name, an actor, a time,
 * and a diff.
 *
 * The diff is the part that was missing. `before` and `after` have been written
 * for sixty-odd phases and never once displayed.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * The audit actions that are one of Phase 70's five corrections.
 *
 * Two actions map to `document.void` because cancelling is one act on two
 * kinds of document — which is why the vocabulary calls it "the document"
 * rather than naming either.
 */
const CORRECTION_ACTIONS: Record<string, CorrectionKind> = {
  'payment.void': 'payment.void',
  'refund.void': 'refund.void',
  'invoice.void': 'document.void',
  'bill.void': 'document.void',
  'deposit.void': 'deposit.void',
  'bill.approval_withdraw': 'approval.withdraw',
}

export type Name = {
  /** What the entry is headed. */
  label: string
  /**
   * Whether somebody decided these words, or they are the action's own name.
   *
   * The screen shows the two differently — a decided phrase reads as a
   * sentence, an action name reads as a code — so that nobody mistakes
   * `journal.reclassify` for prose this system chose to write.
   */
  named: boolean
}

/** What to call what happened. */
export function nameOf(action: string): Name {
  const kind = CORRECTION_ACTIONS[action]
  if (kind) return { label: correction(kind).done, named: true }

  return { label: action, named: false }
}

/**
 * Keys that are not a change to report.
 *
 * `reason` is the *why*, surfaced on its own; showing it as a field that went
 * from nothing to "Keyed at ten times the amount" buries the one thing
 * somebody opened the history to read.
 */
const NOT_A_CHANGE = new Set(['reason'])

export type ChangeKind = 'money' | 'plain' | 'secret'

export type Change = {
  key: string
  label: string
  /**
   * Money is handed back as the integer cents it is stored as, and formatted by
   * the screen. Which currency an amount is in is not a fact this payload
   * carries, and a core that guessed would be the Phase 61 defect — a made-up
   * number in front of somebody — in a new place.
   */
  kind: ChangeKind
  from: string | null
  to: string | null
}

/** How a stored value reads. Matches `parties/changes`, deliberately. */
function display(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * Field labels worth deciding, for the payloads a person actually opens.
 *
 * Anything absent falls through to `humanise`, which is a presentation rule
 * rather than an invented word: it un-camel-cases the key the code already
 * chose. `approvedBy` becoming "Approved by" is not this module deciding
 * anything; `bankAccount` becoming "Their bank account — check this one"
 * would be, which is why the consequential ones are named here explicitly.
 */
const FIELD_LABELS: Record<string, string> = {
  approvedBy: 'Approved by',
  enteredBy: 'Entered by',
  status: 'State',
  number: 'Number',
  // Phase 50's control. "Approvals on" and "everything over £500" are the two
  // halves of a decision somebody made about their own money leaving.
  enabled: 'Approvals required',
  thresholdCents: 'Approval threshold',
  twoPersonRule: 'Second pair of eyes',
  // Phase 45's fraud-vector fields, named rather than humanised so that the
  // one an attacker wants reads as itself in the log.
  taxId: 'Tax ID',
  is1099Vendor: 'Reportable on a 1099',
  paymentTermsDays: 'Payment terms',
  addressLine1: 'Address',
  addressLine2: 'Address line 2',
  postalCode: 'Postcode',
  region: 'County or state',
}

/** `balanceCents` → "Balance". A rule about the key, not a new word. */
export function humanise(key: string): string {
  const withoutCents = key.replace(/Cents$/, '')
  const spaced = withoutCents.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
  const lower = spaced.toLowerCase()
  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
}

function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? humanise(key)
}

/**
 * What actually changed between the two payloads.
 *
 * Both sides matter and either may be absent. Most events record only an
 * `after` — creating something has no before — and those still have fields
 * worth reading, so a missing `before` produces changes from nothing rather
 * than no changes at all.
 *
 * A key whose value did not move is not a change, for the same reason Phase 45
 * gave: a log that reports what stayed the same buries the one thing that did
 * not.
 */
export function changedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Change[] {
  const from = before ?? {}
  const to = after ?? {}

  // `after` first, then anything only `before` had — so a field that was
  // cleared still appears, at the end, rather than vanishing along with its
  // value. That is the case somebody is most often looking for.
  const keys = [...Object.keys(to), ...Object.keys(from).filter((key) => !(key in to))]

  const changes: Change[] = []

  for (const key of keys) {
    if (NOT_A_CHANGE.has(key)) continue

    const wasValue = from[key]
    const nowValue = to[key]

    // An object or an array in a payload is a nested structure this has no
    // words for. Skipped rather than printed as `[object Object]`, which is
    // worse than an omission because it looks like a value.
    if (isNested(wasValue) || isNested(nowValue)) continue

    const was = display(wasValue)
    const now = display(nowValue)
    if (was === now) continue

    /**
     * A value the log may keep and a screen may never print (Phase 72).
     *
     * That it changed is the auditable fact; what it changed to is not.
     * Redacted here, at the reader, so it also covers the rows written before
     * anybody noticed the two halves of this codebase disagreed about it.
     */
    if (isSecret(key)) {
      changes.push({
        key,
        label: labelFor(key),
        kind: 'secret',
        from: maskSecret(was),
        to: maskSecret(now),
      })
      continue
    }

    changes.push({
      key,
      label: labelFor(key),
      kind: key.endsWith('Cents') ? 'money' : 'plain',
      from: was,
      to: now,
    })
  }

  return changes
}

function isNested(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

/** The reason somebody typed, when Phase 70 asked them for one. */
export function reasonFrom(after: Record<string, unknown> | null | undefined): string | null {
  const value = after?.reason
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export type Told = Name & {
  action: string
  /** Field by field, which is what `before` and `after` were written for. */
  changes: Change[]
  /** Why, when it was asked for or offered. */
  reason: string | null
}

/** One audit row, as much of it as there are words for. */
export function tell(row: {
  action: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}): Told {
  return {
    ...nameOf(row.action),
    action: row.action,
    changes: changedFields(row.before, row.after),
    reason: reasonFrom(row.after),
  }
}
