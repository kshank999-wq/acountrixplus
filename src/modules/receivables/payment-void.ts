/**
 * Taking a payment back (spec §13, §16, §19).
 *
 * ## What was missing
 *
 * Everything. There was **no way to void a payment at all** — not a server
 * action with no caller, not a service function nobody wired up. Nothing.
 *
 * `recordPayment` has existed since Phase 2. Phase 41 made it reachable, Phase
 * 44 gave it a card path, Phase 49 turned it into a batch that pays several
 * suppliers at once. A payment keyed as $1,500 instead of $150, or a pay run
 * aimed at the wrong supplier, was **permanent**: the document showed settled,
 * the bank showed the money gone, and the only remaining move was a hand-posted
 * journal entry that fixes the ledger and leaves the invoice still claiming to
 * be paid.
 *
 * Phase 51 then closed the last bad door — you may no longer void the ledger
 * half of a payment from the journal screen — and its refusal says *"Void the
 * payment that produced it"*, pointing at a button that did not exist. This
 * phase is the other end of that sentence.
 *
 * ## The costly wrong answer
 *
 * Not "a wrong payment stayed on the books". It is **unwinding a payment whose
 * money has already been counted by somebody else.** A receipt that has been
 * banked on a deposit, or counted into a till at the end of a shift, or settled
 * by a card processor, is money a second record already claims. Silently
 * putting it back leaves a deposit that no longer adds up, a shift count
 * somebody signed that no longer matches, or a processor payout with nothing
 * behind it.
 *
 * So most of this module is refusals, and each one names the record that has
 * the money now.
 *
 * Nothing here touches the database or the clock.
 */

export type VoidablePayment = {
  id: string
  kind: 'receipt' | 'disbursement'
  paymentDate: string
  amountCents: number
  status: 'posted' | 'void'
  reference: string | null
}

/** What else already claims this payment's money. */
export type PaymentTies = {
  /** The deposit that has banked this receipt, if any. */
  depositNumber: string | null
  /** The drawer shift the cash went into, if any, and whether it is closed. */
  shift: { label: string; closed: boolean } | null
  /** Whether a card checkout for it has settled at the processor. */
  settledAtProcessor: boolean
  /**
   * Documents it settled that have since been voided.
   *
   * Restoring a balance onto a voided invoice would make a document that says
   * "this was cancelled" also say "and $900 is owed on it".
   */
  voidedDocuments: string[]
}

export const NO_TIES: PaymentTies = {
  depositNumber: null,
  shift: null,
  settledAtProcessor: false,
  voidedDocuments: [],
}

export type ClosedPeriod = { periodStart: string; periodEnd: string }

export type VoidVerdict =
  | {
      ok: true
      /**
       * What to do with the journal entry behind it — Phase 51's rule, applied
       * here rather than re-decided.
       */
      ledger: 'void' | 'reverse'
      /** Set when the ledger is reversed rather than voided. */
      reversalDate?: string
      why: string
    }
  | { ok: false; why: string }

/** Whether a date falls inside a closed period. */
export function isClosed(date: string, closedPeriods: ClosedPeriod[]): boolean {
  return closedPeriods.some((p) => p.periodStart <= date && date <= p.periodEnd)
}

/**
 * Whether this payment may be taken back, and how the ledger should unwind.
 *
 * The order is deliberate: the refusals that name *somebody else's record* come
 * before the ones about our own books, because "the bank has this money now" is
 * a more useful thing to be told than "that period is closed".
 */
export function voidability(input: {
  payment: VoidablePayment
  ties: PaymentTies
  closedPeriods: ClosedPeriod[]
  today: string
}): VoidVerdict {
  const { payment, ties, closedPeriods, today } = input

  if (payment.status === 'void') {
    return { ok: false, why: 'That payment has already been voided.' }
  }

  if (ties.depositNumber) {
    /**
     * Named precisely, because following this sentence in the browser is how
     * its first draft was found wanting: it said *"take it off the deposit
     * first"*, and there is no such operation. A deposit is voided whole —
     * that is what the Deposits screen offers — and the receipts on it go back
     * to waiting to be banked. Advice that names a button nobody has is the
     * same defect Phase 51 shipped and this one had to avoid.
     */
    return {
      ok: false,
      why:
        `That receipt has been banked on deposit ${ties.depositNumber}. Void that deposit on the ` +
        'Deposits screen first and bank the rest again — otherwise the deposit still claims money ' +
        'that no longer exists, and the bank reconciliation stops adding up.',
    }
  }

  if (ties.shift?.closed) {
    return {
      ok: false,
      why:
        `That cash was counted into ${ties.shift.label}, and the shift has been closed off. ` +
        'A count somebody signed cannot be changed after the fact — post an adjustment for the ' +
        'difference instead, so the correction is visible rather than retrospective.',
    }
  }

  if (ties.settledAtProcessor) {
    return {
      ok: false,
      why:
        'The card processor has already settled that payment, so the money really did arrive. ' +
        'Refund it through the processor — voiding the record here would leave a payout in the ' +
        'bank with nothing behind it.',
    }
  }

  if (ties.voidedDocuments.length > 0) {
    const names = ties.voidedDocuments.slice(0, 3).join(', ')
    const more =
      ties.voidedDocuments.length > 3 ? ` and ${ties.voidedDocuments.length - 3} more` : ''

    return {
      ok: false,
      why:
        `${names}${more} ${ties.voidedDocuments.length === 1 ? 'has' : 'have'} been voided since ` +
        'this payment settled them. Putting the balance back would leave a cancelled document ' +
        'claiming to be owed.',
    }
  }

  /**
   * Phase 51's rule, not a second opinion on it. An entry dated inside a closed
   * period is reversed rather than voided, because voiding silently changes
   * numbers somebody has already reported.
   */
  if (isClosed(payment.paymentDate, closedPeriods)) {
    if (isClosed(today, closedPeriods)) {
      return {
        ok: false,
        why:
          'That payment is in a closed period and today is closed too, so there is nowhere to ' +
          'post the correction. Reopen a period first.',
      }
    }

    return {
      ok: true,
      ledger: 'reverse',
      reversalDate: today,
      why:
        `That payment falls in a closed period, so the ledger is corrected by a reversal dated ` +
        `${today} rather than by voiding the original — a period already reported on does not ` +
        'change quietly.',
    }
  }

  return {
    ok: true,
    ledger: 'void',
    why:
      'The payment goes void, what it settled goes back to being owed, and the ledger entry is ' +
      'voided with it. All three stay listed.',
  }
}

export type Restoration = {
  documentId: string
  number: string
  /** What goes back onto the document. */
  amountCents: number
  balanceBeforeCents: number
  balanceAfterCents: number
  /** What the document's status becomes once the money is put back. */
  status: 'open' | 'partial'
}

/**
 * What each document goes back to.
 *
 * `open` when the whole of it is owed again, `partial` when something else has
 * also been paid against it. **Never back to `draft`** — a document that was
 * issued and then part-paid was still issued, and rewinding it to draft would
 * take it off the aging report a business is working from.
 */
export function restorationsFor(
  applications: {
    documentId: string
    number: string
    amountCents: number
    balanceCents: number
    totalCents: number
  }[],
): Restoration[] {
  return applications.map((application) => {
    const after = application.balanceCents + application.amountCents

    return {
      documentId: application.documentId,
      number: application.number,
      amountCents: application.amountCents,
      balanceBeforeCents: application.balanceCents,
      balanceAfterCents: after,
      status: after >= application.totalCents ? 'open' : 'partial',
    }
  })
}

/** What to tell somebody the void will do, before they press it. */
export function describeUnwind(restorations: Restoration[]): string {
  if (restorations.length === 0) {
    return 'It settled nothing, so nothing goes back onto a document.'
  }

  const total = restorations.reduce((sum, row) => sum + row.amountCents, 0)
  const names = restorations
    .slice(0, 3)
    .map((row) => row.number)
    .join(', ')
  const more = restorations.length > 3 ? ` and ${restorations.length - 3} more` : ''

  return (
    `${(total / 100).toFixed(2)} goes back onto ${restorations.length} ` +
    `document${restorations.length === 1 ? '' : 's'} — ${names}${more}.`
  )
}
