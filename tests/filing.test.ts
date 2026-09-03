import { describe, expect, it } from 'vitest'
import {
  KIND_CONCERNS,
  columnsFor,
  filingFor,
  type Party,
} from '@/modules/engagement/filing'
import type { TransactionalKind } from '@/modules/notify/transactional'

/**
 * Whose record a letter belongs on (Phase 93).
 *
 * The property the module exists for is the one asserted in "the divide": no
 * letter is ever filed against a party on the opposite side of the books from
 * the one it concerns. A remittance advice on a customer's record is evidence
 * about a payables relationship stored against a receivables one.
 */

const CONTACT: Party = { kind: 'contact', id: 'c1', organizationId: 'org1' }
const CUSTOMER: Party = { kind: 'customer', id: 'k1', organizationId: null }
const VENDOR: Party = { kind: 'vendor', id: 'v1', organizationId: null }

const ALL_KINDS = Object.keys(KIND_CONCERNS) as TransactionalKind[]

describe('filingFor: the party a letter is about', () => {
  it('files an invoice on the customer, not the contact', () => {
    expect(filingFor('invoice', [CONTACT, CUSTOMER])).toBe(CUSTOMER)
  })

  it('files a statement on the customer', () => {
    expect(filingFor('statement', [CUSTOMER, VENDOR])).toBe(CUSTOMER)
  })

  it('files a remittance on the supplier', () => {
    expect(filingFor('remittance', [CONTACT, VENDOR])).toBe(VENDOR)
  })

  it('files an invitation on the person', () => {
    expect(filingFor('company_invitation', [CONTACT, CUSTOMER])).toBe(CONTACT)
  })
})

describe('the divide is never crossed', () => {
  /**
   * The harm this module exists to prevent: one shared inbox that is both a
   * customer and a supplier — a firm that buys from you and sells to you.
   */
  it('does not put our payment advice on somebody’s debt to us', () => {
    expect(filingFor('remittance', [CUSTOMER, VENDOR])).toBe(VENDOR)
  })

  it('does not put their invoice on our supplier record', () => {
    expect(filingFor('invoice', [CUSTOMER, VENDOR])).toBe(CUSTOMER)
  })

  it('files nothing rather than falling back across the divide', () => {
    // A remittance to an address that is only a customer. Filing it there
    // would be the exact defect; filing nothing loses a timeline entry, which
    // is the lesser harm because it is not *wrong*.
    expect(filingFor('remittance', [CUSTOMER])).toBeNull()
    expect(filingFor('invoice', [VENDOR])).toBeNull()
  })

  it('never returns a party on the opposite side, for any kind', () => {
    const opposite: Record<string, string> = { customer: 'vendor', vendor: 'customer' }

    for (const kind of ALL_KINDS) {
      for (const matches of [[CUSTOMER], [VENDOR], [CUSTOMER, VENDOR], [CONTACT, CUSTOMER, VENDOR]]) {
        const filed = filingFor(kind, matches)
        if (!filed) continue
        expect(filed.kind, `${kind} filed on a ${filed.kind}`).not.toBe(
          opposite[KIND_CONCERNS[kind]],
        )
      }
    }
  })
})

describe('the fallback', () => {
  it('falls back to a contact, who is not a side of the books', () => {
    // An invoice to an address the CRM knows as a person but the ledger does
    // not know as a customer. Filing on the person is what Phase 22 already
    // did, and is still right.
    expect(filingFor('invoice', [CONTACT])).toBe(CONTACT)
    expect(filingFor('remittance', [CONTACT])).toBe(CONTACT)
  })

  it('does not fall back when the letter is already about a person', () => {
    // No second guess: a kind that concerns a contact has nowhere else to go.
    expect(filingFor('password_reset', [CUSTOMER])).toBeNull()
    expect(filingFor('company_invitation', [VENDOR])).toBeNull()
  })
})

describe('refusing to guess', () => {
  it('files nothing when the address matched nobody', () => {
    // The ordinary case for a letter to a stranger, and not a failure.
    expect(filingFor('invoice', [])).toBeNull()
  })

  it('files nothing when two of one kind share an address', () => {
    // An entry on the wrong customer is evidence about the wrong party. A
    // timeline that is quietly wrong is worse than one that is quietly short.
    const twin: Party = { kind: 'customer', id: 'k2', organizationId: null }
    expect(filingFor('invoice', [CUSTOMER, twin])).toBeNull()
  })

  it('does not fall back past an ambiguity to something else', () => {
    // Two customers and one contact: the answer is not "the contact", because
    // the letter is about a customer and we cannot say which.
    const twin: Party = { kind: 'customer', id: 'k2', organizationId: null }
    expect(filingFor('invoice', [CUSTOMER, twin, CONTACT])).toBeNull()
  })

  it('refuses an ambiguous fallback too', () => {
    const twin: Party = { kind: 'contact', id: 'c2', organizationId: null }
    expect(filingFor('invoice', [CONTACT, twin])).toBeNull()
  })
})

describe('KIND_CONCERNS', () => {
  it('names a party for every kind this application sends', () => {
    // Exhaustive by construction — a missing kind would not compile — and
    // asserted so the count is visible when another is added. Nine since
    // Phase 98's `email_change`, which is a letter to a person about their own
    // account and so concerns a contact, the answer `password_reset` gives.
    expect(ALL_KINDS).toHaveLength(9)
    for (const kind of ALL_KINDS) {
      expect(['contact', 'customer', 'vendor']).toContain(KIND_CONCERNS[kind])
    }
  })

  it('puts money owed to us and money we paid on opposite records', () => {
    expect(KIND_CONCERNS.invoice).toBe('customer')
    expect(KIND_CONCERNS.statement).toBe('customer')
    expect(KIND_CONCERNS.remittance).toBe('vendor')
  })
})

describe('columnsFor', () => {
  it('sets exactly the one column the party belongs in', () => {
    expect(columnsFor(CUSTOMER)).toEqual({
      organizationId: null,
      contactId: null,
      customerId: 'k1',
      vendorId: null,
    })
    expect(columnsFor(VENDOR)).toEqual({
      organizationId: null,
      contactId: null,
      customerId: null,
      vendorId: 'v1',
    })
  })

  it('carries the organization when the party has one', () => {
    // So a letter to a customer who is also a CRM client still lands on that
    // client's timeline, which is where somebody with both looks first.
    const linked: Party = { kind: 'customer', id: 'k1', organizationId: 'org1' }
    expect(columnsFor(linked)).toMatchObject({ organizationId: 'org1', customerId: 'k1' })
    expect(columnsFor(CONTACT)).toMatchObject({ organizationId: 'org1', contactId: 'c1' })
  })

  it('is all nulls when nothing was filed', () => {
    expect(columnsFor(null)).toEqual({
      organizationId: null,
      contactId: null,
      customerId: null,
      vendorId: null,
    })
  })

  it('never names two parties at once', () => {
    for (const party of [CONTACT, CUSTOMER, VENDOR, null]) {
      const columns = columnsFor(party)
      const named = [columns.contactId, columns.customerId, columns.vendorId].filter(Boolean)
      expect(named.length).toBeLessThanOrEqual(1)
    }
  })
})
