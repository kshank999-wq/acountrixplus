import { describe, expect, it } from 'vitest'
import {
  clashesAmong,
  describeClash,
  normaliseAddress,
  summarise,
  type Party,
} from '@/modules/parties/addresses'

/**
 * When two parties share an address (Phase 94).
 *
 * The property that matters most is the first one asserted: a customer and a
 * supplier on one inbox is ordinary business and must never be reported. Phase
 * 93 built `filingFor` precisely so that arrangement works, and an alarm that
 * fires on it is one somebody switches off before the day it matters.
 */

function customer(id: string, name: string, email: string | null): Party {
  return { side: 'customer', id, name, email }
}

function vendor(id: string, name: string, email: string | null): Party {
  return { side: 'vendor', id, name, email }
}

describe('across the sides is business', () => {
  it('says nothing about one firm that both buys and sells', () => {
    const shared = 'accounts@harborview.test'

    expect(
      clashesAmong([customer('k1', 'Harborview', shared), vendor('v1', 'Harborview', shared)]),
    ).toEqual([])
  })

  it('still says nothing when three parties span both sides', () => {
    // Two suppliers and one customer: the supplier pair is the defect, and the
    // customer must not be dragged into it.
    const shared = 'accounts@harborview.test'
    const clashes = clashesAmong([
      customer('k1', 'Harborview', shared),
      vendor('v1', 'Harborview Plant', shared),
      vendor('v2', 'Harborview Haulage', shared),
    ])

    expect(clashes).toHaveLength(1)
    expect(clashes[0].side).toBe('vendor')
    expect(clashes[0].parties.map((party) => party.id)).toEqual(['v1', 'v2'])
  })
})

describe('within a side is a defect', () => {
  it('finds two customers on one address', () => {
    const shared = 'accounts@duplicated.test'
    const clashes = clashesAmong([
      customer('k1', 'One Ltd', shared),
      customer('k2', 'Two Ltd', shared),
    ])

    expect(clashes).toHaveLength(1)
    expect(clashes[0]).toMatchObject({ side: 'customer', address: shared })
    expect(clashes[0].parties.map((party) => party.name)).toEqual(['One Ltd', 'Two Ltd'])
  })

  it('finds two suppliers on one address', () => {
    const shared = 'ap@supplier.test'
    const clashes = clashesAmong([vendor('v1', 'A', shared), vendor('v2', 'B', shared)])

    expect(clashes).toHaveLength(1)
    expect(clashes[0].side).toBe('vendor')
  })

  it('counts everybody on the address, not just the pair', () => {
    const shared = 'accounts@duplicated.test'
    const clashes = clashesAmong([
      customer('k1', 'One', shared),
      customer('k2', 'Two', shared),
      customer('k3', 'Three', shared),
    ])

    expect(clashes[0].parties).toHaveLength(3)
  })
})

describe('normalisation', () => {
  it('ignores case and surrounding space, which are typing', () => {
    // The same `lower(btrim(...))` the send path has always matched on, so the
    // check reports exactly the addresses that would actually collide.
    const clashes = clashesAmong([
      customer('k1', 'One', '  Accounts@Duplicated.TEST '),
      customer('k2', 'Two', 'accounts@duplicated.test'),
    ])

    expect(clashes).toHaveLength(1)
    expect(clashes[0].address).toBe('accounts@duplicated.test')
  })

  it('does not collapse plus-addressing, which is somebody being tidy', () => {
    // One mailbox, deliberately split by account. Reporting it would call the
    // tidy arrangement the mess.
    expect(
      clashesAmong([
        customer('k1', 'One', 'accounts+ridgeline@harborview.test'),
        customer('k2', 'Two', 'accounts+kestrel@harborview.test'),
      ]),
    ).toEqual([])
  })

  it('is null for an address that is not one', () => {
    expect(normaliseAddress(null)).toBeNull()
    expect(normaliseAddress(undefined)).toBeNull()
    expect(normaliseAddress('   ')).toBeNull()
    expect(normaliseAddress(' A@b.test ')).toBe('a@b.test')
  })

  it('never treats two parties with no address as a clash', () => {
    // Otherwise every company with two customers nobody has emailed would be
    // reported, which is most of them.
    expect(
      clashesAmong([
        customer('k1', 'One', null),
        customer('k2', 'Two', null),
        customer('k3', 'Three', '  '),
      ]),
    ).toEqual([])
  })
})

describe('ordering', () => {
  it('puts the worst first, and is stable for the same books', () => {
    const parties = [
      customer('k1', 'One', 'b@x.test'),
      customer('k2', 'Two', 'b@x.test'),
      customer('k3', 'Three', 'a@x.test'),
      customer('k4', 'Four', 'a@x.test'),
      customer('k5', 'Five', 'a@x.test'),
    ]

    const clashes = clashesAmong(parties)
    expect(clashes.map((clash) => clash.address)).toEqual(['a@x.test', 'b@x.test'])

    // Same input, same report — a check that reorders between runs looks like
    // something changed when nothing did.
    expect(clashesAmong([...parties].reverse()).map((c) => c.address)).toEqual([
      'a@x.test',
      'b@x.test',
    ])
  })
})

describe('describeClash', () => {
  it('names them, because "2 duplicates" is not actionable', () => {
    const [clash] = clashesAmong([
      customer('k1', 'One Ltd', 'accounts@x.test'),
      customer('k2', 'Two Ltd', 'accounts@x.test'),
    ])

    expect(describeClash(clash)).toBe(
      '2 customers share accounts@x.test: One Ltd, Two Ltd.',
    )
  })

  it('calls a vendor a supplier, which is what the screens call them', () => {
    const [clash] = clashesAmong([vendor('v1', 'A', 'ap@x.test'), vendor('v2', 'B', 'ap@x.test')])
    expect(describeClash(clash)).toContain('2 suppliers share')
  })
})

describe('summarise', () => {
  it('is absent when the books are clean', () => {
    // Absent rather than "0 found", so the check reports no detail at all.
    expect(summarise([])).toBeUndefined()
  })

  it('names the worst one', () => {
    const clashes = clashesAmong([
      customer('k1', 'One Ltd', 'accounts@x.test'),
      customer('k2', 'Two Ltd', 'accounts@x.test'),
    ])

    expect(summarise(clashes)).toBe('2 customers share accounts@x.test: One Ltd, Two Ltd.')
  })

  it('counts the rest without listing them', () => {
    const clashes = clashesAmong([
      customer('k1', 'One', 'a@x.test'),
      customer('k2', 'Two', 'a@x.test'),
      customer('k3', 'Three', 'b@x.test'),
      customer('k4', 'Four', 'b@x.test'),
    ])

    const line = summarise(clashes)
    expect(line).toContain('And 1 more address shared.')
    // The worst is named in full; the others are a count, not a wall of text.
    expect(line).not.toContain('Three')
  })

  it('pluralises the remainder', () => {
    const clashes = clashesAmong([
      customer('k1', 'One', 'a@x.test'),
      customer('k2', 'Two', 'a@x.test'),
      customer('k3', 'Three', 'b@x.test'),
      customer('k4', 'Four', 'b@x.test'),
      customer('k5', 'Five', 'c@x.test'),
      customer('k6', 'Six', 'c@x.test'),
    ])

    expect(summarise(clashes)).toContain('And 2 more addresses shared.')
  })
})
