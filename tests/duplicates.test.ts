import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createBill, createCustomer, createInvoice, createVendor } from '@/modules/receivables/service'
import {
  listCustomerSummaries,
  listVendorSummaries,
  sharedAddresses,
} from '@/modules/parties/service'
import { clashesAmong, type Party } from '@/modules/parties/addresses'
import {
  partiesInClashes,
  resolve,
  resolveAll,
  standingOf,
  type Footprint,
} from '@/modules/parties/duplicates'

/**
 * Which of two records sharing an address can be tidied away (Phase 95).
 *
 * The property that matters most is asserted twice, from both directions: a
 * record with any document against it is never offered for retirement, however
 * long ago it stopped trading. Archiving it would hide half of a business's
 * history behind a second identity, which is the opposite of the fix.
 */

const SHARED = 'accounts@cascade.test'

function footprint(id: string, over: Partial<Footprint> = {}): Footprint {
  return {
    id,
    documentCount: 0,
    openDocuments: 0,
    balanceCents: 0,
    heldCreditCents: 0,
    ...over,
  }
}

function customers(...ids: string[]): Party[] {
  return ids.map((id) => ({
    side: 'customer' as const,
    id,
    name: id.toUpperCase(),
    email: SHARED,
  }))
}

const clashOf = (...ids: string[]) => clashesAmong(customers(...ids))[0]

describe('standingOf', () => {
  it('calls a record with no documents untouched', () => {
    expect(standingOf(footprint('a'))).toBe('untouched')
  })

  it('calls a record that has traded and finished settled', () => {
    expect(standingOf(footprint('a', { documentCount: 3 }))).toBe('settled')
  })

  it('calls an open document trading', () => {
    expect(
      standingOf(footprint('a', { documentCount: 3, openDocuments: 1, balanceCents: 5000 })),
    ).toBe('trading')
  })

  it('calls held money trading, even with nothing open', () => {
    // Somebody is owed that money back. Archiving the record is how that stops
    // being anybody's job.
    expect(
      standingOf(footprint('a', { documentCount: 2, heldCreditCents: 40_000 })),
    ).toBe('trading')
  })

  it('calls a balance trading even when the document count disagrees', () => {
    // A balance with no counted document is a books problem, not a spare
    // record. Either way it is not something to archive.
    expect(standingOf(footprint('a', { balanceCents: -2500 }))).toBe('trading')
  })
})

describe('one record has history', () => {
  it('keeps the invoiced one and offers the empty one', () => {
    const resolution = resolve(clashOf('a', 'b'), [
      footprint('a', { documentCount: 4 }),
      footprint('b'),
    ])

    expect(resolution.advice).toBe('retire-the-empty')
    expect(resolution.keepId).toBe('a')
    expect(resolution.dispositions.find((one) => one.id === 'a')?.retirable).toBe(false)
    expect(resolution.dispositions.find((one) => one.id === 'b')?.retirable).toBe(true)
  })

  it('names both, because "one of these" is not actionable', () => {
    // Names come from the clash, which is the only place they live.
    const [clash] = clashesAmong([
      { side: 'customer', id: 'a', name: 'Cascade Joinery', email: SHARED },
      { side: 'customer', id: 'b', name: 'Cascade Joinery Ltd', email: SHARED },
    ])

    const resolution = resolve(clash, [footprint('a', { documentCount: 4 })])

    expect(resolution.because).toContain('Cascade Joinery has documents')
    expect(resolution.because).toContain('Cascade Joinery Ltd has never been invoiced')
  })

  it('counts the empty ones rather than listing three names', () => {
    const resolution = resolve(clashOf('a', 'b', 'c', 'd'), [
      footprint('a', { documentCount: 1 }),
    ])

    expect(resolution.advice).toBe('retire-the-empty')
    expect(resolution.because).toContain('The other 3 have never been invoiced')
    expect(resolution.dispositions.filter((one) => one.retirable)).toHaveLength(3)
  })
})

describe('both records have history', () => {
  it('refuses to pick, whichever of settled and trading they are', () => {
    const resolution = resolve(clashOf('a', 'b'), [
      footprint('a', { documentCount: 9, openDocuments: 2, balanceCents: 120_000 }),
      footprint('b', { documentCount: 1 }),
    ])

    expect(resolution.advice).toBe('merge')
    expect(resolution.keepId).toBeNull()
    expect(resolution.because).toContain('merge')
  })

  it('never offers the settled one, however quiet it is', () => {
    // Phase 56 would happily deactivate a record with nothing outstanding. This
    // phase still must not *advise* it: the history stays attached to a second
    // identity, so "what did this business buy from us" keeps two answers.
    const resolution = resolve(clashOf('a', 'b'), [
      footprint('a', { documentCount: 40, openDocuments: 3, balanceCents: 90_000 }),
      footprint('b', { documentCount: 1 }),
    ])

    expect(resolution.dispositions.map((one) => one.retirable)).toEqual([false, false])
    expect(resolution.dispositions.find((one) => one.id === 'b')?.standing).toBe('settled')
  })

  it('is a merge for two live accounts too', () => {
    const resolution = resolve(clashOf('a', 'b'), [
      footprint('a', { documentCount: 2, openDocuments: 1, balanceCents: 10_000 }),
      footprint('b', { documentCount: 5, openDocuments: 2, balanceCents: 20_000 }),
    ])

    expect(resolution.advice).toBe('merge')
    expect(resolution.because).toContain('2 of these customers have documents')
  })
})

describe('neither record has history', () => {
  it('says so plainly rather than picking one', () => {
    const resolution = resolve(clashOf('a', 'b'), [footprint('a'), footprint('b')])

    expect(resolution.advice).toBe('choose')
    expect(resolution.keepId).toBeNull()
    expect(resolution.dispositions.every((one) => one.retirable)).toBe(true)
    expect(resolution.because).toContain('nothing distinguishes them')
  })

  it('treats a party with no footprint at all as untouched', () => {
    // The clash came from the same list of active parties, so a missing
    // footprint means no documents — which is what untouched means. Dropping
    // the party instead would silently shrink the clash.
    const resolution = resolve(clashOf('a', 'b'), [])

    expect(resolution.dispositions).toHaveLength(2)
    expect(resolution.advice).toBe('choose')
  })
})

describe('what it says', () => {
  it('calls a vendor a supplier, which is what the screens call them', () => {
    const [clash] = clashesAmong([
      { side: 'vendor', id: 'v1', name: 'A', email: 'ap@x.test' },
      { side: 'vendor', id: 'v2', name: 'B', email: 'ap@x.test' },
    ])

    expect(resolve(clash, []).because).toContain('suppliers')
  })

  it('never claims the two records are the same business', () => {
    // They share an inbox. That is all anybody knows, and it is why Phase 94
    // made this a position rather than a fault: a parent and its subsidiary
    // genuinely may share an accounts inbox and genuinely are two customers.
    const lines = [
      resolve(clashOf('a', 'b'), [footprint('a', { documentCount: 1 })]).because,
      resolve(clashOf('a', 'b'), [
        footprint('a', { documentCount: 1 }),
        footprint('b', { documentCount: 1 }),
      ]).because,
      resolve(clashOf('a', 'b'), []).because,
    ]

    for (const line of lines) {
      expect(line).not.toMatch(/duplicate|same (business|customer|company)|these are one/i)
    }
  })

  it('carries the address and side, so a resolution stands alone', () => {
    const resolution = resolve(clashOf('a', 'b'), [])
    expect(resolution).toMatchObject({ side: 'customer', address: SHARED })
  })
})

describe('resolveAll and partiesInClashes', () => {
  it('resolves each clash against one pool of footprints', () => {
    const clashes = clashesAmong([
      { side: 'customer', id: 'a', name: 'A', email: 'one@x.test' },
      { side: 'customer', id: 'b', name: 'B', email: 'one@x.test' },
      { side: 'vendor', id: 'v1', name: 'V1', email: 'two@x.test' },
      { side: 'vendor', id: 'v2', name: 'V2', email: 'two@x.test' },
    ])

    const resolutions = resolveAll(clashes, [footprint('a', { documentCount: 3 })])

    expect(resolutions).toHaveLength(2)
    expect(resolutions.find((one) => one.side === 'customer')?.advice).toBe('retire-the-empty')
    expect(resolutions.find((one) => one.side === 'vendor')?.advice).toBe('choose')
  })

  it('collects every party caught in any clash', () => {
    const clashes = clashesAmong([
      { side: 'customer', id: 'a', name: 'A', email: 'one@x.test' },
      { side: 'customer', id: 'b', name: 'B', email: 'one@x.test' },
      { side: 'customer', id: 'c', name: 'C', email: 'alone@x.test' },
    ])

    const caught = partiesInClashes(clashes)
    expect(caught.has('a')).toBe(true)
    expect(caught.has('b')).toBe(true)
    expect(caught.has('c')).toBe(false)
  })

  it('is an empty set for clean books', () => {
    expect(partiesInClashes([]).size).toBe(0)
  })
})

/**
 * The assembly the customers screen actually performs.
 *
 * The core above is pure and proves the judgement. These prove the page can
 * make that judgement from what it already loads — that `sharedAddresses` and
 * `listCustomerSummaries` line up on ids, and that a real invoice moves a real
 * record out of `untouched`. A core that decides correctly on data the page
 * cannot assemble is a core nobody runs.
 */
describe('against the database', () => {
  let fixture: Fixture
  let revenueId: string

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Duplicates Co' })
    revenueId = (await fixture.account('4000')).id
  })

  /** Exactly what `PeoplePage` does: read both, resolve, no third query. */
  async function asThePageDoes() {
    const [clashes, customerRows, vendorRows] = await Promise.all([
      sharedAddresses(fixture.ctx),
      listCustomerSummaries(fixture.ctx),
      listVendorSummaries(fixture.ctx),
    ])

    return resolveAll(clashes, [...customerRows, ...vendorRows])
  }

  it('offers the never-invoiced record and keeps the invoiced one', async () => {
    const shared = 'accounts@cascade.test'
    const traded = await createCustomer(fixture.ctx, { name: 'Cascade Joinery', email: shared })
    const spare = await createCustomer(fixture.ctx, { name: 'Cascade Joinery Ltd', email: shared })

    await createInvoice(fixture.ctx, {
      customerId: traded.id,
      issueDate: '2026-02-01',
      dueDate: '2026-03-03',
      lines: [{ chartAccountId: revenueId, description: 'Fit-out', unitPriceCents: 180_000 }],
    })

    const [resolution] = await asThePageDoes()

    expect(resolution.advice).toBe('retire-the-empty')
    expect(resolution.keepId).toBe(traded.id)
    expect(resolution.dispositions.find((one) => one.id === spare.id)).toMatchObject({
      standing: 'untouched',
      retirable: true,
    })
  })

  it('will not offer either once both have traded', async () => {
    const shared = 'ap@twinned.test'
    const first = await createVendor(fixture.ctx, { name: 'Twinned Supplies', email: shared })
    const second = await createVendor(fixture.ctx, { name: 'Twinned Supplies Co', email: shared })
    const expenseId = (await fixture.account('6000')).id

    for (const vendorId of [first.id, second.id]) {
      await createBill(fixture.ctx, {
        vendorId,
        vendorReference: `REF-${vendorId.slice(0, 6)}`,
        issueDate: '2026-02-01',
        dueDate: '2026-03-03',
        lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: 40_000 }],
      })
    }

    const [resolution] = await asThePageDoes()

    expect(resolution.advice).toBe('merge')
    expect(resolution.dispositions.every((one) => one.retirable)).toBe(false)
  })

  it('says nothing at all when the books are clean', async () => {
    await createCustomer(fixture.ctx, { name: 'One', email: 'one@clean.test' })
    await createCustomer(fixture.ctx, { name: 'Two', email: 'two@clean.test' })

    expect(await asThePageDoes()).toEqual([])
  })

  it('says nothing about a customer and a supplier on one inbox', async () => {
    // Phase 94's rule, proved through the real registers rather than a fixture.
    const shared = 'accounts@harborview.test'
    await createCustomer(fixture.ctx, { name: 'Harborview', email: shared })
    await createVendor(fixture.ctx, { name: 'Harborview', email: shared })

    expect(await asThePageDoes()).toEqual([])
  })
})
