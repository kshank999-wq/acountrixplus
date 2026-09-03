import { describe, expect, it } from 'vitest'
import {
  POSTINGS,
  composition,
  countOf,
  netByParty,
  postingsFor,
  reconcile,
  signFor,
  type PartyAmount,
} from '@/modules/ledger/control-account'

/**
 * What a control account is made of (Phase 106).
 *
 * Phase 31 proved the balance sheet against the aging report and summed the
 * subledger side from open invoices alone. A credit note credits 1100 the
 * moment it is issued — `applyCredit` posts no entry at all — so between issue
 * and application the ledger has moved and the subledger has not, and the check
 * reports a fault on a state the application fully supports.
 *
 * The claim this file is about: the subledger side of a control account is
 * every document that posts to it, and each declares which way it moves.
 */

const amount = (over: Partial<PartyAmount> = {}): PartyAmount => ({
  id: 'c1',
  name: 'Harborview LLC',
  kind: 'invoice',
  cents: 100_000,
  documents: 1,
  ...over,
})

describe('what posts where', () => {
  it('gives receivables both an increase and a decrease', () => {
    const kinds = postingsFor('receivables').map((posting) => posting.kind)

    expect(kinds).toEqual(['invoice', 'credit_note'])
    expect(signFor('receivables', 'invoice')).toBe(1)
    // The whole defect in one assertion.
    expect(signFor('receivables', 'credit_note')).toBe(-1)
  })

  it('gives payables the mirror of it', () => {
    expect(signFor('payables', 'bill')).toBe(1)
    expect(signFor('payables', 'vendor_credit')).toBe(-1)
  })

  it('refuses a document that posts to the other account', () => {
    // Not zero. A silent zero is exactly how the credit note stayed out of the
    // receivables sum for seventy-five phases.
    expect(() => signFor('receivables', 'bill')).toThrow(/declares how a bill/)
    expect(() => signFor('payables', 'invoice')).toThrow()
  })

  it('makes every posting argue for itself', () => {
    for (const posting of POSTINGS) {
      expect(posting.because.length, posting.kind).toBeGreaterThan(60)
    }
    // The one that was missing says why it was easy to miss.
    const credit = POSTINGS.find((p) => p.kind === 'credit_note')!
    expect(credit.because).toContain('not when it is applied')
  })

  it('declares each kind against exactly one account', () => {
    const seen = POSTINGS.map((posting) => `${posting.account}:${posting.kind}`)
    expect(new Set(seen).size).toBe(seen.length)
    expect(new Set(POSTINGS.map((p) => p.kind)).size).toBe(POSTINGS.length)
  })
})

describe('netting a party', () => {
  it('takes a credit off the customer who holds it', () => {
    const parties = netByParty('receivables', [
      amount(),
      amount({ kind: 'credit_note', cents: 30_000 }),
    ])

    expect(parties).toHaveLength(1)
    expect(parties[0].balanceCents).toBe(70_000)
    // Both documents are still counted; only the money nets.
    expect(parties[0].documents).toBe(2)
  })

  it('drops a party whose credits exactly cover their invoices', () => {
    const parties = netByParty('receivables', [
      amount(),
      amount({ kind: 'credit_note', cents: 100_000 }),
    ])

    expect(parties).toEqual([])
  })

  it('keeps a party whose credits exceed their invoices', () => {
    // Money the business owes them. Hiding it is the same failure this file
    // exists to fix, in the other direction.
    const parties = netByParty('receivables', [
      amount(),
      amount({ kind: 'credit_note', cents: 130_000 }),
    ])

    expect(parties).toHaveLength(1)
    expect(parties[0].balanceCents).toBe(-30_000)
  })

  it('keeps two parties apart', () => {
    const parties = netByParty('receivables', [
      amount(),
      amount({ id: 'c2', name: 'Beacon Ltd', cents: 40_000 }),
      amount({ id: 'c2', name: 'Beacon Ltd', kind: 'credit_note', cents: 10_000 }),
    ])

    expect(parties.map((party) => [party.name, party.balanceCents])).toEqual([
      ['Harborview LLC', 100_000],
      ['Beacon Ltd', 30_000],
    ])
  })

  it('orders worst first, and breaks a tie by name', () => {
    const parties = netByParty('receivables', [
      amount({ id: 'z', name: 'Zenith', cents: 50_000 }),
      amount({ id: 'a', name: 'Apex', cents: 50_000 }),
    ])

    expect(parties.map((party) => party.name)).toEqual(['Apex', 'Zenith'])
  })
})

describe('the reconciliation', () => {
  it('agrees once the credit note is counted', () => {
    // The measured failure: ledger 70000 against a subledger of open invoices
    // reading 100000. Counting the credit note is the whole fix.
    const result = reconcile('receivables', 70_000, [
      amount(),
      amount({ kind: 'credit_note', cents: 30_000 }),
    ])

    expect(result.subledgerCents).toBe(70_000)
    expect(result.agrees).toBe(true)
    expect(result.differenceCents).toBe(0)
  })

  it('still catches the split Phase 31 was built for', () => {
    // An entry posted straight at 1100 with no document behind it. Counting
    // credit notes must not make the check blind to this.
    const result = reconcile('receivables', 136_500, [amount()])

    expect(result.agrees).toBe(false)
    expect(result.differenceCents).toBe(36_500)
  })

  it('counts every document, including the ones that reduce the total', () => {
    const result = reconcile('receivables', 70_000, [
      amount(),
      amount({ kind: 'credit_note', cents: 30_000 }),
    ])

    expect(result.documents).toBe(2)
  })

  it('says what each kind contributed, signed', () => {
    const result = reconcile('receivables', 70_000, [
      amount(),
      amount({ kind: 'credit_note', cents: 30_000 }),
    ])

    expect(result.byKind).toEqual([
      { kind: 'invoice', cents: 100_000, documents: 1 },
      { kind: 'credit_note', cents: -30_000, documents: 1 },
    ])
  })

  it('leaves out a kind with no documents rather than showing a zero', () => {
    const result = reconcile('receivables', 100_000, [amount()])

    expect(result.byKind.map((entry) => entry.kind)).toEqual(['invoice'])
  })

  it('reconciles payables the same way', () => {
    const result = reconcile('payables', 60_000, [
      amount({ kind: 'bill', cents: 80_000 }),
      amount({ kind: 'vendor_credit', cents: 20_000 }),
    ])

    expect(result.subledgerCents).toBe(60_000)
    expect(result.agrees).toBe(true)
  })
})

describe('the sentence a person reads', () => {
  it('counts one document as one', () => {
    expect(countOf('credit_note', 1)).toBe('1 credit note')
    expect(countOf('credit_note', 2)).toBe('2 credit notes')
    expect(countOf('vendor_credit', 1)).toBe('1 vendor credit')
  })

  it('says what the figure is made of, and which part came off it', () => {
    const result = reconcile('receivables', 70_000, [
      amount(),
      amount({ kind: 'credit_note', cents: 30_000 }),
    ])

    expect(composition(result)).toBe('1 invoice worth $1,000.00, 1 credit note less $300.00')
  })

  it('names the currency it was given', () => {
    const result = reconcile('receivables', 70_000, [amount({ cents: 70_000 })])
    expect(composition(result, 'EUR')).toContain('€700.00')
  })

  it('has something to say when there is nothing open', () => {
    expect(composition(reconcile('receivables', 0, []))).toBe('No open documents.')
  })
})
