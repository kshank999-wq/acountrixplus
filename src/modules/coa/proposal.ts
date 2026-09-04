import type { AccountType } from './standard'

/**
 * Whether a proposed chart account is coherent (spec §5, Phase 118).
 *
 * ## The defect
 *
 * `createAccount` was written in Phase 1 — *"Creates a custom account (spec §5
 * allows full customization)"* — and in the **117 phases since, nothing has
 * ever called it.** There is no screen showing the chart of accounts at all:
 * it is read as a dropdown in nine places and managed in none. An accounting
 * product where a business cannot see or extend its own chart.
 *
 * That is Phase 49's defect again, and ADR 0049 wrote down what it costs:
 *
 * > `applyVendorCredit` had existed since Phase 12 with no caller anywhere in
 * > `src/app`, so a vendor credit with anything left on it was stranded for
 * > ever.
 *
 * ## And what it validated
 *
 * Nothing. No number, no name, no uniqueness — a duplicate number reached the
 * unique index and came back as a raw Postgres error rather than a sentence,
 * and an expense could be numbered `1050` and sit among the assets.
 *
 * So the refusals arrive with the screen, because a screen that accepts
 * anything is how a chart of accounts stops being one.
 *
 * ## The ranges are this project's own, not a convention borrowed from a book
 *
 * Measured from the chart this application installs: assets 1000–1999,
 * liabilities 2000–2999, equity 3000–3999, revenue 4000–4999, cost of sales
 * 5000–5999, expenses 6000–6999, other income 7000–8999, other expenses
 * 9000–9999. Every one of the 500 seeded accounts obeys it.
 *
 * A number is not merely decoration: it is what an accountant reads first and
 * what every chart in every other system is sorted by, so an account whose
 * number contradicts its type is a trap for whoever inherits the books.
 */

/** One band of the chart, and what belongs in it. */
export type NumberRange = {
  type: AccountType
  /** Inclusive, four digits. */
  from: number
  to: number
  /** What an accountant expects to find here. */
  because: string
}

export const NUMBER_RANGES: readonly NumberRange[] = [
  {
    type: 'asset',
    from: 1000,
    to: 1999,
    because:
      'What the business owns or is owed — bank accounts, receivables, stock, equipment. The ' +
      'top of the balance sheet, and the top of the chart.',
  },
  {
    type: 'liability',
    from: 2000,
    to: 2999,
    because:
      'What the business owes — suppliers, tax, money held for somebody else. Directly below ' +
      'the assets it is set against.',
  },
  {
    type: 'equity',
    from: 3000,
    to: 3999,
    because: 'What is left over for the owners once the liabilities are met, and what they put in.',
  },
  {
    type: 'revenue',
    from: 4000,
    to: 4999,
    because: 'What the business earned by doing the thing it does. The first line of the P&L.',
  },
  {
    type: 'cogs',
    from: 5000,
    to: 5999,
    because:
      'What that revenue cost directly — materials, the stock that was sold, subcontracted ' +
      'labour. Kept apart from overheads because gross margin is the number a trade reads.',
  },
  {
    type: 'expense',
    from: 6000,
    to: 6999,
    because: 'The overheads: rent, insurance, software, wages that are not on a job.',
  },
  {
    type: 'other_income',
    from: 7000,
    to: 8999,
    because:
      'Money the business made without selling anything — interest, a currency movement, a ' +
      'gain on selling a van. Below the operating result on purpose, because it says nothing ' +
      'about whether the trade is working.',
  },
  {
    type: 'other_expense',
    from: 9000,
    to: 9999,
    because: 'The mirror: interest paid, a loss on disposal, anything the trade did not cause.',
  },
]

/** The band a type belongs to. Throws on a type nobody declared. */
export function rangeFor(type: AccountType): NumberRange {
  const range = NUMBER_RANGES.find((row) => row.type === type)
  if (!range) {
    throw new Error(
      `No number range is declared for account type "${type}". A new type has to say where ` +
        'in the chart it belongs before an account can be given one.',
    )
  }
  return range
}

export type AccountProposal = {
  number: string
  name: string
  type: AccountType
}

export type ProposalVerdict =
  | { ok: true; number: string; name: string }
  | { ok: false; why: string }

/**
 * Whether this account can be added, and what to say when it cannot.
 *
 * Every refusal names the thing that is wrong and what would fix it, on the
 * Phase 47 rule — a refusal a person reads is worth more than a constraint
 * violation they cannot act on.
 *
 * `taken` is every number already on the chart, active or not: a retired
 * account still owns its number, because the journal entries behind it still
 * point at it and reusing the number would put two different accounts' history
 * under one heading.
 */
export function proposeAccount(input: {
  proposal: AccountProposal
  taken: readonly string[]
  /** Numbers the application looks up by name and installs itself. */
  reserved: readonly string[]
}): ProposalVerdict {
  const number = input.proposal.number.trim()
  const name = input.proposal.name.trim()

  if (name.length === 0) {
    return { ok: false, why: 'An account needs a name. It is what everybody reads on a report.' }
  }

  if (!/^\d{4}$/.test(number)) {
    return {
      ok: false,
      why: `"${number || 'blank'}" is not an account number. Four digits, like 6210 — the chart ` +
        'is sorted by it and every other system expects the same shape.',
    }
  }

  if (input.reserved.includes(number)) {
    return {
      ok: false,
      why: `${number} is one of the accounts this application installs and looks up by number. ` +
        'Taking it would leave the software posting into an account somebody else named. Pick ' +
        'another number in the same range.',
    }
  }

  if (input.taken.includes(number)) {
    return {
      ok: false,
      why: `${number} is already on this chart. A retired account keeps its number, because the ` +
        'entries behind it still point there and reusing it would file two accounts under one ' +
        'heading.',
    }
  }

  const range = rangeFor(input.proposal.type)
  const value = Number(number)
  if (value < range.from || value > range.to) {
    return {
      ok: false,
      why: `${number} is outside ${range.from}–${range.to}, where ${labelFor(range.type)} live. ` +
        `${range.because} An account whose number contradicts its type is a trap for whoever ` +
        'inherits the books.',
    }
  }

  return { ok: true, number, name }
}

/** How each type reads in a sentence. */
export function labelFor(type: AccountType): string {
  switch (type) {
    case 'asset':
      return 'assets'
    case 'liability':
      return 'liabilities'
    case 'equity':
      return 'equity accounts'
    case 'revenue':
      return 'revenue accounts'
    case 'cogs':
      return 'cost of sales accounts'
    case 'expense':
      return 'expenses'
    case 'other_income':
      return 'other income'
    case 'other_expense':
      return 'other expenses'
  }
}
