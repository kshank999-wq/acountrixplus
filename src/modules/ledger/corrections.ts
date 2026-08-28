/**
 * Correcting a journal entry (spec §2, §13, §19).
 *
 * ## What was wrong
 *
 * The journal screen tells you the principle in its own header:
 *
 * > *"Voided entries stay listed — the ledger corrects by reversal, never by
 * > deletion."*
 *
 * and then offers neither correction. `voidEntry` has existed since Phase 2
 * with **no caller anywhere in `src/app`**; `reverseEntry` has existed since
 * Phase 2 with no server action at all, reachable only sideways when a deposit
 * is unwound; and `entryWithLines` has existed since Phase 2 with no caller
 * either. So the list showed a number, a date, a memo and a status — **no
 * debits, no credits, no money** — and an entry posted to the wrong account
 * could neither be read nor put right.
 *
 * ## The costly wrong answer
 *
 * Not "an entry stayed wrong" — that is a nuisance. It is **wiring the void
 * button up naively**, because `voidEntry` checks a permission and an open
 * period and nothing else. Void the entry behind INV-1002 and the invoice
 * still says $24,000 is owed while Accounts Receivable no longer carries it:
 * the subledger and the ledger disagree, which is the one thing Phase 31 went
 * to the trouble of proving they never do.
 *
 * So the interesting decision here is not *how* to correct an entry. It is
 * **which entries may be corrected this way at all**, and that is what this
 * module decides.
 *
 * ## The three answers
 *
 * - **Refuse** — the entry is the ledger half of a document. Correct the
 *   document; the ledger follows.
 * - **Reverse** — the entry falls in a period somebody has already closed and
 *   reported on. The correction belongs in the current period, visible, rather
 *   than silently rewriting a prior one.
 * - **Void** — a hand-posted entry in an open period, which nothing downstream
 *   depends on and nobody has reported.
 *
 * Nothing here touches the database or the clock.
 */

/** A journal entry, as this module needs to see it. */
export type CorrectableEntry = {
  id: string
  entryNumber: number
  entryDate: string
  status: 'posted' | 'void'
  /** Where the entry came from: 'manual', 'invoice', 'payroll', and so on. */
  source: string
  /** The table of the originating document, when there is one. */
  sourceType: string | null
  /** Set when this entry is itself a reversal of another. */
  reversalOfId: string | null
}

/** A period a company has closed. `reopened` ones are not closed. */
export type ClosedPeriod = { periodStart: string; periodEnd: string }

export type CorrectionMethod = 'void' | 'reverse'

export type CorrectionVerdict =
  | { ok: true; method: 'void'; why: string }
  | { ok: true; method: 'reverse'; reversalDate: string; why: string }
  | { ok: false; why: string }

/**
 * Whether an entry is the ledger half of a document.
 *
 * Two tests rather than one, because both catch cases the other misses. The
 * source enum names most of them (`invoice`, `bill`, `payroll`, `takings`…),
 * but a *reversal* posted by `reverseEntry` carries source `adjusting` while
 * copying the original's `sourceType` — so unwinding a deposit produces an
 * `adjusting` entry that is still tied to a document. A hand-posted entry has
 * `source: 'manual'` and `sourceType: null`, and nothing else does.
 */
export function isDerived(entry: CorrectableEntry): boolean {
  if (entry.sourceType !== null) return true
  return entry.source !== 'manual' && entry.source !== 'adjusting'
}

/** What to go and correct instead, for an entry that is not ours to touch. */
export function documentAdvice(entry: CorrectableEntry): string {
  switch (entry.source) {
    case 'invoice':
      return 'Void the invoice on Invoices & bills; the ledger follows it.'
    case 'bill':
      return 'Void the bill on Invoices & bills; the ledger follows it.'
    case 'payment':
      return 'Void the payment that produced it; the ledger follows it.'
    case 'bank_transaction':
      return 'Re-categorise the bank transaction in Bookkeeping; the ledger follows it.'
    case 'payroll':
      return 'Void the payroll run on Payroll & tax; the ledger follows it.'
    case 'remittance':
      return 'Void the remittance that produced it; the ledger follows it.'
    case 'closing':
      return 'Reopen the year under Recurring & close and close it again.'
    default:
      return 'Correct the document it came from; the ledger follows it.'
  }
}

/** Whether a date falls inside a closed period. */
export function isClosed(date: string, closedPeriods: ClosedPeriod[]): boolean {
  return closedPeriods.some(
    (period) => period.periodStart <= date && date <= period.periodEnd,
  )
}

/**
 * The date a reversal should carry.
 *
 * The entry's own date when that period is still open — the correction sits
 * beside what it corrects, which is what somebody reading the ledger expects.
 * Otherwise today, because the current period is where a correction to a
 * reported one belongs. Null when today is closed too, which is a state a
 * company has to resolve by reopening something rather than by posting.
 */
export function reversalDateFor(
  entry: CorrectableEntry,
  closedPeriods: ClosedPeriod[],
  today: string,
): string | null {
  if (!isClosed(entry.entryDate, closedPeriods)) return entry.entryDate
  if (!isClosed(today, closedPeriods)) return today
  return null
}

/**
 * How this entry may be corrected, if at all.
 *
 * The order matters. "Already void" comes before everything because it is a
 * statement about the entry rather than about the books; "derived" comes next
 * because no period rule can rescue an entry that must not be touched at all.
 */
export function correctionFor(input: {
  entry: CorrectableEntry
  closedPeriods: ClosedPeriod[]
  today: string
  /** The number of an entry that already reverses this one, if any. */
  reversedBy?: number | null
}): CorrectionVerdict {
  const { entry, closedPeriods, today, reversedBy } = input

  if (entry.status === 'void') {
    return { ok: false, why: `Entry #${entry.entryNumber} is already void.` }
  }

  if (reversedBy) {
    return {
      ok: false,
      why:
        `Entry #${entry.entryNumber} has already been reversed by #${reversedBy}. ` +
        'Reversing it again would put the original amount back on the books.',
    }
  }

  if (isDerived(entry)) {
    return {
      ok: false,
      why:
        `Entry #${entry.entryNumber} is the ledger half of a document, not a hand-posted ` +
        `entry. ${documentAdvice(entry)}`,
    }
  }

  if (!isClosed(entry.entryDate, closedPeriods)) {
    return {
      ok: true,
      method: 'void',
      why:
        `Entry #${entry.entryNumber} falls in an open period, so voiding it leaves no gap in ` +
        'anything already reported. It stays listed as void.',
    }
  }

  const reversalDate = reversalDateFor(entry, closedPeriods, today)

  if (!reversalDate) {
    return {
      ok: false,
      why:
        `Entry #${entry.entryNumber} is in a closed period and today is closed too, so there is ` +
        'nowhere to post the correction. Reopen a period first.',
    }
  }

  return {
    ok: true,
    method: 'reverse',
    reversalDate,
    why:
      `Entry #${entry.entryNumber} falls in a closed period, so it is reversed rather than ` +
      `voided — the correction appears on ${reversalDate}, where somebody reading the books ` +
      'can see it, instead of silently changing a period already reported on.',
  }
}

/**
 * Whether a method somebody explicitly asked for is allowed.
 *
 * Separate from `correctionFor` because the screen offers the recommendation
 * and the action receives whatever arrived on the wire. An accountant may
 * reasonably want to reverse an open-period entry rather than void it — they
 * gave last month's numbers to the bank on a Tuesday and the period is still
 * open — so reversing is allowed wherever voiding is. **Voiding a closed
 * period is not**, in either direction.
 */
export function mayUse(input: {
  entry: CorrectableEntry
  method: CorrectionMethod
  closedPeriods: ClosedPeriod[]
  today: string
  reversedBy?: number | null
}): { ok: true } | { ok: false; why: string } {
  const verdict = correctionFor(input)

  if (!verdict.ok) return { ok: false, why: verdict.why }
  if (verdict.method === input.method) return { ok: true }

  // The recommendation was `reverse` and they asked to void: refused, because
  // the reason for the recommendation was a closed period.
  if (input.method === 'void') {
    return { ok: false, why: verdict.ok ? verdict.why : 'That entry cannot be voided.' }
  }

  // The recommendation was `void` and they asked to reverse: allowed.
  return { ok: true }
}
