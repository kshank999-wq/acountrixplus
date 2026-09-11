/**
 * When two carried balances meet (Phase 137).
 *
 * ## The defect
 *
 * Applying a credit note to an invoice reduces **two** balances that are
 * carried at **two different rates**, for one face amount. `applyCreditWithin`
 * relieved both and posted nothing, on the argument written above it:
 *
 * > "No journal entry is posted here: the credit note's own entry already moved
 * > the receivable, and this is an allocation between the two."
 *
 * True of the face amounts and false of the functional ones. Measured, on a
 * euro invoice raised at 1.10 and a euro credit note issued at 1.0835:
 *
 * ```
 * INVOICE  face 100000 functional 110000
 * NOTE     face 100000 functional 108350
 * BEFORE  subledger 1650 ledger 1650 agrees true
 * AFTER   subledger    0 ledger 1650 agrees false
 * ```
 *
 * €1,000 invoiced, €1,000 credited, the customer owes nothing — and **$16.50
 * stays in Accounts Receivable for good.** `ledger.receivables` is a `fault`
 * and it fails every night afterwards, on a difference nobody can clear: the
 * invoice is settled, the note is spent, and there is no document left to point
 * at. The business is told its books are broken and given no way to fix them.
 *
 * ## This is Phase 114's defect, in the two places its fix did not reach
 *
 * ADR 0114 — "The credit spent at a rate it was never carried at" — found
 * `applyCredit` in `customer-credit.ts` converting both sides at the invoice's
 * rate and posting no difference, and repaired it with Phase 68's `settleHeld`.
 * Its own comment, still in that file, describes this phase exactly:
 *
 * > "Two balances are being moved and they are carried at **two different
 * > rates** … `settleHeld` is the rule Phase 68 wrote for exactly this."
 *
 * It fixed the path that spends a **held payment**. The two that spend a
 * **credit note** — `applyCreditWithin` on an invoice, `applyVendorCreditWithin`
 * on a bill — were never looked at, and there is a second `applyCredit`, in a
 * different module, which is part of why: the name was already taken by the
 * function that had been repaired.
 *
 * The rates need not be different currencies to differ. A euro invoice in June
 * and a euro credit note in July are one currency at two rates, which is the
 * ordinary case rather than the exotic one.
 *
 * ## Why a new module rather than another `settleHeld` caller
 *
 * `settleHeld` answers "what is the gap", and this reuses it rather than
 * recomputing — two answers to one question is the defect, and Phase 116
 * removed exactly that from `fx.conversions`.
 *
 * What it does **not** answer is where the gap goes, and here that is a
 * genuinely different question from the one `applyCredit` faced. There, held
 * money and the receivable are two different accounts, so the entry has a side
 * to land on. Here **both documents sit in the same control account**, so the
 * difference is between that control account and the exchange account — and
 * which way round it goes is the opposite for a payable, because the same rate
 * movement that loses money on something owed to us makes money on something we
 * owe.
 */

/** Which control account the two documents share. */
export type Control = 'receivable' | 'payable'

export type Meeting = {
  /**
   * What the document being paid down gives up, at its own carried rate — the
   * invoice's or the bill's.
   */
  relievedCents: number
  /**
   * What the credit gives up, at the rate **it** has been carried at since it
   * was issued. Not a fresh conversion: `relieveFunctional` on the note's own
   * pair, which is the figure its entry actually posted.
   */
  releasedCents: number
  control: Control
}

export type Meets =
  | { posts: false; why: string }
  | {
      posts: true
      /** Always positive; `side` says which way. */
      differenceCents: number
      /** What the control account needs, to agree with the subledger again. */
      control: 'debit' | 'credit'
      /** What the exchange account gets. */
      exchange: 'debit' | 'credit'
      outcome: 'gain' | 'loss'
      why: string
    }

/**
 * What a credit application leaves in the control account, and the entry that
 * takes it out again.
 *
 * Pure: no database, no clock, no account ids. The caller looks those up.
 */
export function meets(input: Meeting): Meets {
  const { relievedCents, releasedCents, control } = input

  // The document came down by this much and the credit only covered that much,
  // so this is what is left sitting in the control account with no document
  // behind it.
  const strandedCents = relievedCents - releasedCents

  if (strandedCents === 0) {
    return {
      posts: false,
      why:
        'Both documents are carried at the same rate, so the control account comes down by ' +
        'exactly what the subledger does and there is nothing to name. Every single-currency ' +
        'application is this case, which is why a hundred and thirty phases never noticed.',
    }
  }

  // A receivable is a debit balance and a payable a credit one, so the same
  // stranded figure needs opposite treatment — and means opposite things. We
  // billed when the euro was strong and credited when it was weak: on money
  // owed *to* us that is a loss, and on money *we* owe it is a gain, because
  // the debt got cheaper before we settled it.
  const owedToUs = control === 'receivable'
  const outcome: 'gain' | 'loss' =
    strandedCents > 0 ? (owedToUs ? 'loss' : 'gain') : owedToUs ? 'gain' : 'loss'

  const controlSide: 'debit' | 'credit' =
    strandedCents > 0 ? (owedToUs ? 'credit' : 'debit') : owedToUs ? 'debit' : 'credit'

  return {
    posts: true,
    differenceCents: Math.abs(strandedCents),
    control: controlSide,
    exchange: controlSide === 'debit' ? 'credit' : 'debit',
    outcome,
    why:
      `The ${owedToUs ? 'invoice' : 'bill'} came down by ${relievedCents} and the credit note ` +
      `covered ${releasedCents}, both in the company's own money and both at the rate their own ` +
      `document has been carried at. The ${Math.abs(strandedCents)} between them is a realised ` +
      `exchange ${outcome}, and without it that figure stays in the control account with no ` +
      'document behind it.',
  }
}
