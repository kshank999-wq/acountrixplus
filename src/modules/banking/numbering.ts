import type { AccountType } from '@/modules/coa/standard'

/**
 * Where a new bank account's ledger account goes, and what to number it
 * (spec §5, §19).
 *
 * ## Why this exists
 *
 * A financial account — the thing the bank knows about — is not the same as
 * its chart account, the line on the balance sheet the ledger posts to.
 * Everything until now assumed somebody had already made the chart account:
 * `connectInstitution` pointed every non-card account at `1000 Checking
 * Account`, and nothing anywhere could make a new one.
 *
 * So a business with a current account, a deposit account and a card had one
 * balance-sheet line for the first two. The balance sheet said what the two of
 * them held together and could not say what either held, which is the question
 * a bank statement asks. Two accounts sharing one ledger account is not a
 * tidier chart; it is a chart that cannot answer the only question it is for.
 *
 * ## The bands
 *
 * The standard chart already reserves the shape: `1000` checking, `1010`
 * savings, `1050` petty cash, `2100` credit card, `2400` loans. A second
 * current account belongs beside the first, not at the end of the chart, so
 * new accounts are numbered *within the band their kind belongs to* — a second
 * current account is `1001`, not `1600`.
 */

/** What kind of thing the bank is holding for you, or lending you. */
export type FinancialAccountKind = 'checking' | 'savings' | 'credit_card' | 'loan' | 'cash' | 'other'

export type NumberBand = {
  /** First number this kind may take, inclusive. */
  from: number
  /** Last number this kind may take, inclusive. */
  to: number
  /** What the ledger account is, so a new one lands on the right statement. */
  type: AccountType
  /** The chart's own word for it, carried onto the new account. */
  subtype: string
}

/**
 * The band a kind belongs in.
 *
 * Bounded deliberately rather than "anything from 1000 up": a current account
 * numbered 1150 would sit among the receivables on every report that sorts by
 * number, which is every report. Running out of a band is a refusal — see
 * `nextAccountNumber` — because silently spilling into the next one is how a
 * chart stops meaning anything.
 */
export function bandFor(kind: FinancialAccountKind): NumberBand {
  switch (kind) {
    case 'checking':
      return { from: 1000, to: 1009, type: 'asset', subtype: 'bank' }
    case 'savings':
      return { from: 1010, to: 1039, type: 'asset', subtype: 'bank' }
    case 'cash':
      return { from: 1050, to: 1069, type: 'asset', subtype: 'cash' }
    case 'credit_card':
      return { from: 2100, to: 2139, type: 'liability', subtype: 'credit_card' }
    case 'loan':
      return { from: 2400, to: 2439, type: 'liability', subtype: 'long_term_liability' }
    // Something the aggregator could not classify. An asset by default,
    // because the alternative — guessing it is a debt — overstates what is
    // owed, and an overstated debt is the error nobody notices.
    case 'other':
      return { from: 1070, to: 1099, type: 'asset', subtype: 'bank' }
  }
}

/**
 * The next free number in a band, or null when the band is full.
 *
 * `taken` is every number already in the company's chart, not just the ones in
 * this band — a number is unique per company, so a collision anywhere is a
 * collision.
 *
 * Returning null rather than throwing because a full band is a thing the
 * caller has to say something sensible about, and "1010 to 1039 are all in
 * use" is a better sentence than a stack trace. Thirty deposit accounts is not
 * a case worth designing for, but it is a case worth refusing clearly.
 */
export function nextAccountNumber(taken: Iterable<string>, band: NumberBand): string | null {
  const used = new Set<string>()
  for (const number of taken) used.add(number.trim())

  for (let candidate = band.from; candidate <= band.to; candidate += 1) {
    const number = String(candidate)
    if (!used.has(number)) return number
  }

  return null
}

/**
 * A ledger-account name for a bank account somebody just named.
 *
 * The bank account is "Business Checking"; the chart account is what a
 * balance sheet prints. They are the same words, because a chart account
 * called "Checking Account 2" beside a bank account called "Deposit Account"
 * is two names for one thing and somebody will eventually reconcile the wrong
 * one.
 *
 * The mask goes in the name for the same reason it is on the statement: two
 * accounts at one bank are told apart by their last four digits and by nothing
 * else.
 */
export function ledgerNameFor(input: { name: string; mask?: string | null }): string {
  const name = input.name.trim().replace(/\s+/g, ' ')
  const mask = input.mask?.trim()
  return mask ? `${name} ••${mask}` : name
}
