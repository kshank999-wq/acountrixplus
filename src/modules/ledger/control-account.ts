/**
 * What a control account is made of (spec §13, §19).
 *
 * ## The defect
 *
 * A control account is the ledger's one-line summary of a subledger. Phase 31
 * built the check that proves the two agree, and wrote down why it matters:
 *
 * > The balance sheet says £365 is owed; the aging report says nothing is owed;
 * > both are internally consistent, and neither mentions the other.
 *
 * It then summed the subledger side from **open invoices alone** — and invoices
 * are not the only document that posts to `1100`. A credit note credits it the
 * moment it is issued. `applyCredit` says so in as many words:
 *
 * > No journal entry: the credit note already moved the receivable when it was
 * > issued. Applying it is bookkeeping *within* Accounts Receivable.
 *
 * So between issuing a credit note and applying it, the ledger has moved and
 * the subledger has not, and the check reports a **fault** — its highest
 * severity — on a state the application fully supports. `2000` has the same
 * hole from the other side: a vendor credit debits it at issue.
 *
 * Measured, not reasoned about: a $1,000 invoice with a $300 credit note raised
 * against it reports `ledger=70000 subledger=100000`, and the same shape on
 * payables at `ledger=60000 subledger=80000`.
 *
 * That is the Phase 105 argument arriving from the other direction. There the
 * worry was a check too weak to mean anything; here it is a check that cries
 * wolf, and **a check that cries wolf is a check somebody turns off** — with
 * the genuine split Phase 31 was built to catch going out alongside it.
 *
 * ## The fix is not netting credits into the aging report
 *
 * `net-position.ts` refused that in Phase 54, and the reasoning still holds:
 * aging is about what is owed *by age*, and an unapplied credit has no age
 * because nobody has yet decided which invoice it belongs to.
 *
 * This is a narrower claim: **the subledger side of a control account is every
 * document that posts to that control account.** An overpayment is correctly
 * absent — Phase 53 sent it to `2520`, its own account with its own check. A
 * credit note is not: it posts to `1100` itself.
 *
 * So the registry below is the answer to "what moves this account", each entry
 * carrying prose arguing for itself rather than a bare sign, and a document
 * type added later has to answer the question rather than default to invisible.
 *
 * No database and no clock: this file decides, `receivables-check.ts` fetches.
 */

import { formatCents } from '@/lib/money'
import { RegistryError } from '@/modules/errors/registry'

/** The two accounts that summarise a subledger of documents. */
export type ControlAccount = 'receivables' | 'payables'

/** Every document that moves a control account when it is issued. */
export type DocumentKind = 'invoice' | 'credit_note' | 'bill' | 'vendor_credit'

export type Posting = {
  kind: DocumentKind
  account: ControlAccount
  /** Which way it moves the account, read on the account's normal side. */
  direction: 'increases' | 'decreases'
  /** Why this document belongs in this account's subledger. */
  because: string
}

/**
 * What posts to each control account.
 *
 * Prose rather than a boolean, on Phase 70's device: a sign is a fact that
 * looks the same whether it is right or wrong, and the argument for it is the
 * part a reader needs.
 */
export const POSTINGS: Posting[] = [
  {
    kind: 'invoice',
    account: 'receivables',
    direction: 'increases',
    because:
      'Raising an invoice debits 1100 against revenue. It is the document the ' +
      'control account was built to summarise.',
  },
  {
    kind: 'credit_note',
    account: 'receivables',
    direction: 'decreases',
    because:
      'A credit note credits 1100 when it is issued, not when it is applied — ' +
      'applying it only decides which invoice the reduction belongs to, and posts ' +
      'nothing. Counting invoices alone leaves the ledger lower than the subledger ' +
      'for as long as the credit sits unapplied.',
  },
  {
    kind: 'bill',
    account: 'payables',
    direction: 'increases',
    because: 'Entering a bill credits 2000 against the expense it pays for.',
  },
  {
    kind: 'vendor_credit',
    account: 'payables',
    direction: 'decreases',
    because:
      'A vendor credit debits 2000 at issue, the mirror of the credit note. The ' +
      'supplier owes the money back; the payable is smaller from that moment.',
  },
]

/** What posts to one account, in declaration order. */
export function postingsFor(account: ControlAccount): Posting[] {
  return POSTINGS.filter((posting) => posting.account === account)
}

/**
 * Which way a document moves an account: `+1` or `-1`.
 *
 * Throws rather than defaulting. A document kind nobody declared is either a
 * typo or a new posting nobody thought about, and both are better as a loud
 * failure than as a silent zero — silence is exactly how the credit note got
 * left out for seventy-five phases.
 */
export function signFor(account: ControlAccount, kind: DocumentKind): 1 | -1 {
  const posting = postingsFor(account).find((row) => row.kind === kind)
  if (!posting) {
    throw new RegistryError({
      registry: 'POSTINGS',
      key: `${account}/${kind}`,
      message: `Nothing declares how a ${kind} moves ${account}.`,
    })
  }
  return posting.direction === 'increases' ? 1 : -1
}

/** One party's documents of one kind, as the database hands them over. */
export type PartyAmount = {
  id: string
  name: string
  kind: DocumentKind
  /** Always positive: the document's own balance. `signFor` supplies direction. */
  cents: number
  documents: number
}

export type PartyBalance = {
  id: string
  name: string
  /** Signed: negative means the balance runs the other way for this party. */
  balanceCents: number
  documents: number
}

/**
 * Each party's documents netted into one figure, worst first.
 *
 * Two decisions worth stating:
 *
 * **A party who nets to nothing is dropped.** A customer with a $500 invoice
 * and a $500 credit against it belongs in neither the total nor the list of
 * people to look at; leaving them in makes the list longer without making it
 * more useful.
 *
 * **A party who nets *negative* is kept.** A customer whose credits exceed
 * their invoices is not a rounding artefact — it is money the business owes
 * them, and hiding it is the same failure as the one this whole file exists
 * to fix. Their document count is kept too, because the answer to "why is this
 * negative" is the documents.
 */
export function netByParty(account: ControlAccount, rows: PartyAmount[]): PartyBalance[] {
  const byParty = new Map<string, PartyBalance>()

  for (const row of rows) {
    const existing = byParty.get(row.id) ?? { id: row.id, name: row.name, balanceCents: 0, documents: 0 }
    existing.balanceCents += signFor(account, row.kind) * row.cents
    existing.documents += row.documents
    byParty.set(row.id, existing)
  }

  return [...byParty.values()]
    .filter((party) => party.balanceCents !== 0)
    .sort((a, b) => b.balanceCents - a.balanceCents || a.name.localeCompare(b.name))
}

export type Reconciliation = {
  account: ControlAccount
  /** What the posted journal lines say. */
  ledgerCents: number
  /** What the documents say, every kind that posts here. */
  subledgerCents: number
  differenceCents: number
  agrees: boolean
  /** How many documents make up the subledger side. */
  documents: number
  parties: PartyBalance[]
  /** What each kind contributed, for the sentence. Signed. */
  byKind: Array<{ kind: DocumentKind; cents: number; documents: number }>
}

/** The whole comparison, from the ledger figure and the documents behind it. */
export function reconcile(
  account: ControlAccount,
  ledgerCents: number,
  rows: PartyAmount[],
): Reconciliation {
  const parties = netByParty(account, rows)
  const subledgerCents = parties.reduce((sum, party) => sum + party.balanceCents, 0)

  const byKind = postingsFor(account)
    .map((posting) => {
      const matching = rows.filter((row) => row.kind === posting.kind)
      return {
        kind: posting.kind,
        cents: signFor(account, posting.kind) * matching.reduce((sum, row) => sum + row.cents, 0),
        documents: matching.reduce((sum, row) => sum + row.documents, 0),
      }
    })
    .filter((entry) => entry.documents > 0)

  return {
    account,
    ledgerCents,
    subledgerCents,
    differenceCents: ledgerCents - subledgerCents,
    agrees: ledgerCents === subledgerCents,
    documents: byKind.reduce((sum, entry) => sum + entry.documents, 0),
    parties,
    byKind,
  }
}

const KIND_WORDS: Record<DocumentKind, [string, string]> = {
  invoice: ['invoice', 'invoices'],
  credit_note: ['credit note', 'credit notes'],
  bill: ['bill', 'bills'],
  vendor_credit: ['vendor credit', 'vendor credits'],
}

/**
 * "2 invoices", "1 credit note".
 *
 * Noun and count built together, for the reason Phase 105 had to fix twice: a
 * count and a noun assembled in different places drift apart, and the first
 * anybody hears of it is a screen reading "1 retainer hold".
 */
export function countOf(kind: DocumentKind, documents: number): string {
  const [one, many] = KIND_WORDS[kind]
  return `${documents} ${documents === 1 ? one : many}`
}

/**
 * What the subledger side is made of, for a reader who wants to know why the
 * figure is not simply the invoices.
 *
 * Returned even when the two agree, because "these agree" is more convincing
 * when it says what was counted.
 */
export function composition(reconciliation: Reconciliation, currency = 'USD'): string {
  if (reconciliation.byKind.length === 0) return 'No open documents.'

  return reconciliation.byKind
    .map(
      (entry) =>
        `${countOf(entry.kind, entry.documents)} ${entry.cents < 0 ? 'less' : 'worth'} ` +
        `${formatCents(Math.abs(entry.cents), currency)}`,
    )
    .join(', ')
}
