/**
 * What the product calls it when somebody undoes something (spec §19).
 *
 * ## One phrase, four meanings
 *
 * ADR 0068 noticed it and ADR 0069 made it worse. By the end of Phase 69 the
 * words **"Take it back"** appeared on three screens meaning three different
 * things — withdraw a bill's approval, void a payment, and confirm undoing a
 * refund — and "Undo it" meant a fourth.
 *
 * That is the mirror of the defect this codebase keeps refactoring out. The
 * usual one is *two answers to one question*; this is **one answer to four
 * questions**, and it is worse for the person holding the mouse, because the
 * four operations differ in exactly the way that matters: what they move.
 *
 * ## One phrase, one meaning
 *
 * Every correction is named here once, with the verb its button uses, what the
 * confirmation calls it, and what the notice says afterwards. Nothing else in
 * the application writes those words. The point is not tidiness — it is that a
 * screen cannot accidentally reuse a verb that already means something else,
 * because the verbs live in one list where a duplicate is visible.
 *
 * ## Which corrections must say why
 *
 * `voidPayment` has insisted on a reason since Phase 52: *"a void with no
 * reason is a hole somebody has to reconstruct from dates months later."* That
 * was right, and for eighteen phases it was the **only** correction that
 * insisted. `voidDocument`, `voidDeposit`, `withdrawApproval` and Phase 69's
 * own `voidRefund` all took none — so the same reasoning produced opposite
 * behaviour depending on which screen somebody happened to be on.
 *
 * The rule, stated once here rather than decided five times:
 *
 * > **A correction that moved money, or that reached somebody outside the
 * > business, must say why. One that only rearranges what is on our own screens
 * > need not.**
 *
 * So voiding a payment or a refund must (money left or arrived), and cancelling
 * an invoice or a bill must (somebody has been sent it, and may be looking at
 * it). Unbanking a deposit need not — the receipts on it were already recorded
 * individually and go back to waiting; nothing left the business. Withdrawing
 * an approval need not — nothing was posted, and the bill can be approved again
 * by the same person a minute later.
 *
 * Requiring a reason for those two would train people to type "x" into a box,
 * which is worse than not asking: it produces an audit trail that looks
 * complete and says nothing.
 *
 * Nothing here touches the database or the clock.
 */

export type CorrectionKind =
  | 'payment.void'
  | 'refund.void'
  | 'document.void'
  | 'deposit.void'
  | 'approval.withdraw'

/**
 * What a correction actually disturbs, which is what decides the rule above.
 *
 * Kept as its own field rather than a bare `reasonRequired: boolean`, so the
 * next correction somebody adds has to answer the question that matters rather
 * than copy a flag from the row above it.
 */
export type Reach =
  /** Cash left or arrived. */
  | 'moved_money'
  /** A document or letter went to somebody who is not us. */
  | 'reached_somebody'
  /** Only our own records move; nothing outside changes. */
  | 'internal'

export type Correction = {
  kind: CorrectionKind
  reach: Reach
  /** The button. No two of these share a word. */
  verb: string
  /** What the confirmation panel is headed. */
  title: string
  /** Past tense, for the notice afterwards. */
  done: string
  /** What to put above the reason box, when one is asked for. */
  reasonPrompt: string | null
}

const CORRECTIONS: Record<CorrectionKind, Correction> = {
  'payment.void': {
    kind: 'payment.void',
    reach: 'moved_money',
    verb: 'Void the payment',
    title: 'Void this payment',
    done: 'Payment voided',
    reasonPrompt: 'Why is this payment being voided?',
  },
  'refund.void': {
    kind: 'refund.void',
    reach: 'moved_money',
    verb: 'Undo the refund',
    title: 'Undo this refund',
    done: 'Refund undone',
    reasonPrompt: 'Why is this refund being undone?',
  },
  'document.void': {
    kind: 'document.void',
    reach: 'reached_somebody',
    verb: 'Cancel the document',
    title: 'Cancel this document',
    done: 'Document cancelled',
    reasonPrompt: 'Why is it being cancelled? The other party may already have it.',
  },
  'deposit.void': {
    kind: 'deposit.void',
    reach: 'internal',
    // The receipts go back to waiting to be banked; nothing leaves.
    verb: 'Unbank the deposit',
    title: 'Unbank this deposit',
    done: 'Deposit unbanked',
    reasonPrompt: null,
  },
  'approval.withdraw': {
    kind: 'approval.withdraw',
    reach: 'internal',
    verb: 'Withdraw approval',
    title: 'Withdraw this approval',
    done: 'Approval withdrawn',
    reasonPrompt: null,
  },
}

export function correction(kind: CorrectionKind): Correction {
  return CORRECTIONS[kind]
}

export function everyCorrection(): Correction[] {
  return Object.values(CORRECTIONS)
}

/** The rule, applied. */
export function mustSayWhy(kind: CorrectionKind): boolean {
  return CORRECTIONS[kind].reach !== 'internal'
}

export type ReasonVerdict = { ok: true; reason: string | null } | { ok: false; why: string }

/** The longest reason worth storing; past this it is a note, not a reason. */
export const REASON_LIMIT = 500

/**
 * Whether this correction may go ahead with the reason it was given.
 *
 * A blank reason on a correction that needs one is refused **with the prompt
 * itself**, so the sentence a person reads when they are stopped is the same
 * sentence that asked them in the first place. Phase 47's rule: a refusal has
 * to say what is wrong with this row, and pointing at the box is the answer.
 */
export function reasonFor(input: { kind: CorrectionKind; reason?: string | null }): ReasonVerdict {
  const entry = CORRECTIONS[input.kind]
  const reason = (input.reason ?? '').trim()

  if (!reason) {
    if (!mustSayWhy(input.kind)) return { ok: true, reason: null }

    return {
      ok: false,
      why: `${entry.reasonPrompt} Say why, so somebody reading the books later does not have to guess.`,
    }
  }

  if (reason.length > REASON_LIMIT) {
    return {
      ok: false,
      why: `That is longer than ${REASON_LIMIT} characters. Keep the reason short — a note belongs on the record itself.`,
    }
  }

  // Kept even where it was not required: somebody who bothered to explain an
  // internal correction has said something worth keeping.
  return { ok: true, reason }
}
