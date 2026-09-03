/**
 * Every money column carried in two currencies, named once (spec §19, Phase 116).
 *
 * ## Nothing here is a conversion of anything else
 *
 * Five tables carry an amount twice — once in the currency the document is
 * denominated in, once in the company's own — and it is tempting to believe the
 * second is the first put through the rate stored beside it. It is not, and it
 * never has been. **Every functional figure in this system is a sum of
 * conversions, never a conversion of a sum**, and both halves of that are
 * deliberate:
 *
 * - A document's functional total is its **lines** converted and added, because
 *   the header has to store what the journal entry actually posted. Converting
 *   the total separately would leave the balance a cent away from the
 *   receivable it is supposed to equal — the drift the control-account check
 *   exists to find, manufactured by the code meant to prevent it.
 * - A document's functional balance comes down by `relieveFunctional`, which
 *   takes `convert(part, rate)` off on each part payment and **the whole
 *   remainder** on the last, so a settled document cannot strand a cent.
 *
 * Both rules round per movement, and rounding accumulates. A two-line €10.01 +
 * €10.01 invoice at 1.0835 carries **$21.70** where converting its €20.02 total
 * gives **$21.69**. A €1,000 invoice paid in three instalments of €250 carries
 * **$270.86** against a €250 balance that recomputes to **$270.88**. Neither
 * figure is wrong in either case; they answer different questions.
 *
 * So a check that recomputes a functional figure from its face amount is
 * asserting an identity that has never held, and any tolerance it picks is a
 * number somebody guessed. `fx.conversions` did exactly that from Phase 35 to
 * Phase 116, with a tolerance of one cent that ordinary bookkeeping exceeds.
 *
 * ## What is exact
 *
 * One thing, and it is worth a constraint rather than a check: **the two sides
 * reach zero together.** `relieveFunctional`'s last-draw rule guarantees it, and
 * a row breaking it is money sitting on a control account that no document can
 * ever clear — Phase 48's Goods Received Not Invoiced with the sign flipped.
 *
 * A constraint rather than a nightly check because a check reports a thing that
 * has already happened, and this one can be made not to happen.
 */
export type PairKind = 'fixed' | 'moving'

export type PairedColumns = {
  /** The table, as the database names it. */
  table: string
  /** The amount in the document's own currency. */
  faceColumn: string
  /** The same amount in the company's. */
  functionalColumn: string
  /**
   * `fixed` is written once when the document is raised and never touched;
   * `moving` comes down on every settlement. Neither is recomputable, but only
   * `moving` carries the reach-zero-together invariant — a fixed pair has no
   * zero to reach.
   */
  kind: PairKind
  /** The database constraint enforcing that invariant, or `null` for a fixed pair. */
  constraint: string | null
  /** Why this pair is the kind it is, in the terms of the table it sits on. */
  because: string
}

/**
 * A new table carrying a functional amount has to appear here, and `pairsFor`
 * throws on one that does not — the device Phase 101 used for retention
 * policies, for the same reason. The expensive failure is a table nobody
 * remembered to think about, and a registry that answers "I don't know" quietly
 * is no better than no registry at all.
 */
export const PAIRED_COLUMNS: readonly PairedColumns[] = [
  {
    table: 'invoices',
    faceColumn: 'total_cents',
    functionalColumn: 'functional_total_cents',
    kind: 'fixed',
    constraint: null,
    because:
      'What the customer was billed and what the ledger posted for it, both settled the moment ' +
      'the invoice was raised and neither touched again. The functional figure is the lines ' +
      'converted and added, not the total converted, so the two differ by rounding on any ' +
      'multi-line foreign invoice — which is why nothing may recompute it.',
  },
  {
    table: 'invoices',
    faceColumn: 'balance_cents',
    functionalColumn: 'functional_balance_cents',
    kind: 'moving',
    constraint: 'invoices_functional_balance_sane',
    because:
      'What is still owed. Comes down on every receipt, credit note, retainer draw and ' +
      'write-off, so it accumulates rounding — but a paid invoice owes nothing in any ' +
      'currency, and a functional balance outliving a zero face balance is money on the ' +
      'receivables control account that no document can ever clear.',
  },
  {
    table: 'bills',
    faceColumn: 'total_cents',
    functionalColumn: 'functional_total_cents',
    kind: 'fixed',
    constraint: null,
    because:
      'What the supplier billed and what the ledger posted, fixed when the bill was entered. ' +
      'Converted line by line for the same reason an invoice is.',
  },
  {
    table: 'bills',
    faceColumn: 'balance_cents',
    functionalColumn: 'functional_balance_cents',
    kind: 'moving',
    constraint: 'bills_functional_balance_sane',
    because:
      'What is still owed to the supplier. The payables side of the same rule, with the same ' +
      'consequence on the other control account.',
  },
  {
    table: 'credit_notes',
    faceColumn: 'total_cents',
    functionalColumn: 'functional_total_cents',
    kind: 'fixed',
    constraint: null,
    because:
      'A credit note is converted line by line at the rate it inherits from the document it ' +
      'credits, because reversing a document by different arithmetic than raised it is the ' +
      'drift the inheritance exists to prevent.',
  },
  {
    table: 'credit_notes',
    faceColumn: 'remaining_cents',
    functionalColumn: 'functional_remaining_cents',
    kind: 'moving',
    constraint: 'credit_notes_functional_remaining_sane',
    because:
      'How much of the credit is still available to apply. A fully spent credit note is worth ' +
      'nothing to anybody, so a functional remainder on one is a promise the business has ' +
      'already kept and is still carrying.',
  },
  {
    table: 'payments',
    faceColumn: 'unapplied_cents',
    functionalColumn: 'functional_unapplied_cents',
    kind: 'moving',
    constraint: 'payments_functional_unapplied_sane',
    because:
      'What a customer overpaid and the business is still holding. There is no fixed pair on ' +
      'this table: a payment stores its rate and `amount_cents` but no converted total, ' +
      'because the figure the ledger needed was the held part rather than the whole receipt.',
  },
  {
    table: 'retainers',
    faceColumn: 'remaining_cents',
    functionalColumn: 'functional_remaining_cents',
    kind: 'moving',
    constraint: 'retainers_functional_remaining_sane',
    because:
      'Client money not yet drawn against. The first of these to get the constraint, in a raw ' +
      'migration that never reached the schema file — and for fifty phases the only one, which ' +
      'is what Phase 116 found.',
  },
]

export class PairedColumnsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PairedColumnsError'
  }
}

/**
 * The pairs declared on a table, or a refusal.
 *
 * Throws rather than returning an empty list, because "this table carries no
 * paired money" and "nobody has said" look identical to a caller and only one
 * of them is safe to act on.
 */
export function pairsFor(table: string): readonly PairedColumns[] {
  const pairs = PAIRED_COLUMNS.filter((pair) => pair.table === table)
  if (pairs.length === 0) {
    throw new PairedColumnsError(
      `No paired money columns are declared for "${table}". If it carries a functional ` +
        'amount, declare it in PAIRED_COLUMNS with the reason; if it does not, do not ask.',
    )
  }
  return pairs
}

/**
 * Every constraint the moving pairs rely on.
 *
 * Read by the tripwire that asks the database whether each one is really there.
 * A registry claiming a constraint that does not exist is worse than no
 * registry: it is the Phase 110 defect, a declaration nobody verified.
 */
export function movingConstraints(): readonly { table: string; constraint: string }[] {
  return PAIRED_COLUMNS.filter((pair) => pair.kind === 'moving').map((pair) => ({
    table: pair.table,
    constraint: pair.constraint as string,
  }))
}
