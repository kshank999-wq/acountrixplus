import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bills } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createVendor,
  DocumentError,
} from '@/modules/receivables/service'
import { namesakeOf, normaliseName } from '@/modules/payables/namesakes'
import { duplicateExposure, suspectedDuplicateBills } from '@/modules/payables/duplicates'
import { accountByNumber } from '@/modules/coa/service'
import { runIntegrityChecks } from '@/modules/integrity/service'
import { messageFor } from '@/modules/errors'

/**
 * The supplier's reference, and the bill entered twice (Phase 47).
 *
 * The claim under test: **a reference identifies a document within a
 * supplier.** Everything else follows — two suppliers may share a number, one
 * supplier may not repeat one, and the resemblances in between are a question
 * for a person.
 */

let fixture: Fixture
let expenseAccountId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Payables Co' })
  const account = await accountByNumber(fixture.companyId, '6350')
  expenseAccountId = account!.id
})

async function aVendor(name: string) {
  return createVendor(fixture.ctx, { name })
}

async function aBill(
  vendorId: string,
  over: {
    vendorReference?: string | null
    issueDate?: string
    totalCents?: number
    acknowledgeDuplicate?: boolean
  } = {},
) {
  return createBill(fixture.ctx, {
    vendorId,
    vendorReference: over.vendorReference,
    acknowledgeDuplicate: over.acknowledgeDuplicate,
    issueDate: over.issueDate ?? '2026-08-01',
    lines: [
      {
        chartAccountId: expenseAccountId,
        description: 'Professional fees',
        unitPriceCents: over.totalCents ?? 120_000,
      },
    ],
  })
}

describe('entering a bill', () => {
  /**
   * The defect this phase fixes. `bills.number` was unique per *company* while
   * the composer — labelled "Their reference", placeholder INV-4471 — wrote the
   * supplier's own number into it. Two suppliers both numbering an invoice
   * INV-4471 is not a coincidence; it is how invoice numbering works.
   */
  it('lets two suppliers use the same number', async () => {
    const one = await aVendor('Northern Supplies')
    const two = await aVendor('Harbour Plant Hire')

    const first = await aBill(one.id, { vendorReference: 'INV-4471' })
    const second = await aBill(two.id, { vendorReference: 'INV-4471' })

    expect(first.vendorReference).toBe('INV-4471')
    expect(second.vendorReference).toBe('INV-4471')
    // Our own numbers, which are ours and do not collide.
    expect(first.number).not.toBe(second.number)
  })

  it('refuses the same supplier repeating their own reference', async () => {
    const vendor = await aVendor('Northern Supplies')
    const first = await aBill(vendor.id, { vendorReference: 'INV-4471' })

    await expect(
      // A different date and a different amount. Still the same document.
      aBill(vendor.id, {
        vendorReference: 'inv 4471',
        issueDate: '2026-08-20',
        totalCents: 95_000,
      }),
    ).rejects.toThrow(DocumentError)

    const [caught] = await aBill(vendor.id, { vendorReference: 'INV-4472' })
      .then(() => [null])
      .catch((error) => [error])
    expect(caught).toBeNull()

    let message = ''
    try {
      await aBill(vendor.id, { vendorReference: 'INV/4471' })
    } catch (error) {
      message = messageFor(error, 'Something went wrong.')
    }

    // The sentence names the bill it clashes with, so nobody has to search.
    expect(message).toContain(first.number)
    expect(message).not.toBe('Something went wrong.')
  })

  /**
   * The emailed PDF and the posted copy, entered by two people, neither of
   * whom typed the reference. Not certain, so not refused — but not silent
   * either.
   */
  it('warns about the same amount on the same day, and enters it once told to', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor.id)

    await expect(aBill(vendor.id)).rejects.toThrow(DocumentError)

    const anyway = await aBill(vendor.id, { acknowledgeDuplicate: true })
    expect(anyway.id).toBeTruthy()
  })

  /**
   * A warning is overridable and a refusal is not. The machine is certain
   * about exactly one thing; everywhere else the person is holding the invoice
   * and the machine is not.
   */
  it('will not enter a repeated reference however hard it is asked', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor.id, { vendorReference: 'INV-4471' })

    await expect(
      aBill(vendor.id, { vendorReference: 'INV-4471', acknowledgeDuplicate: true }),
    ).rejects.toThrow(DocumentError)
  })

  /**
   * Rent. A monthly charge of the same amount to the same supplier is ordinary
   * and must pass without a warning, or the warning stops being read.
   */
  it('says nothing about the same amount a month later', async () => {
    const vendor = await aVendor('Northgate Properties')
    await aBill(vendor.id, { issueDate: '2026-07-01' })

    const august = await aBill(vendor.id, { issueDate: '2026-08-01' })
    expect(august.id).toBeTruthy()
  })

  it('keeps the reference verbatim and the key comparable', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(vendor.id, { vendorReference: '  inv/4471 ' })

    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id))
    expect(row.vendorReference).toBe('inv/4471')
    expect(row.referenceKey).toBe('INV4471')
  })

  it('stores no key at all when the supplier numbered nothing', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(vendor.id, { vendorReference: '  ' })

    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id))
    expect(row.vendorReference).toBeNull()
    expect(row.referenceKey).toBeNull()
  })

  /**
   * The database is the arbiter, as it is everywhere in this system two people
   * can act at once. The check above is the readable refusal; this is the one
   * that holds when two requests race.
   */
  it('is refused by the database even with the check bypassed', async () => {
    const vendor = await aVendor('Northern Supplies')
    const first = await aBill(vendor.id, { vendorReference: 'INV-4471' })
    const [row] = await db.select().from(bills).where(eq(bills.id, first.id))

    await expect(
      db.insert(bills).values({
        companyId: fixture.companyId,
        vendorId: vendor.id,
        number: 'BILL-9999',
        vendorReference: 'INV-4471',
        referenceKey: 'INV4471',
        issueDate: '2026-09-09',
        dueDate: '2026-10-09',
        status: 'open',
        totalCents: 1,
        balanceCents: 1,
      }),
    ).rejects.toThrow()

    expect(row.referenceKey).toBe('INV4471')
  })

  /**
   * Two unnumbered bills must not collide. Most bills carry no reference, and
   * a partial index is what makes "no reference" mean nothing rather than
   * mean the same as every other bill without one.
   */
  it('lets any number of unnumbered bills exist', async () => {
    const vendor = await aVendor('Northern Supplies')

    await aBill(vendor.id, { issueDate: '2026-01-01' })
    await aBill(vendor.id, { issueDate: '2026-03-01' })
    const third = await aBill(vendor.id, { issueDate: '2026-05-01' })

    expect(third.id).toBeTruthy()
  })
})

describe('our own numbering', () => {
  /**
   * It counted rows until Phase 47, which is only the same answer while every
   * document was generated. The import wizard supplies its own numbers, and a
   * company with four of those got its next generated bill at 1005 — colliding
   * with an imported BILL-1005 on a raw unique violation reported as
   * "Something went wrong."
   */
  it('carries on from the highest number issued, not the row count', async () => {
    const vendor = await aVendor('Northern Supplies')

    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      number: 'BILL-1005',
      issueDate: '2026-01-01',
      lines: [
        { chartAccountId: expenseAccountId, description: 'Migrated', unitPriceCents: 5_000 },
      ],
    })

    const next = await aBill(vendor.id, { issueDate: '2026-02-01', totalCents: 7_000 })
    expect(next.number).toBe('BILL-1006')
  })

  it('starts at 1001 for a company with no bills', async () => {
    const vendor = await aVendor('Northern Supplies')
    const first = await aBill(vendor.id)
    expect(first.number).toBe('BILL-1001')
  })
})

describe('the bills already entered twice', () => {
  /**
   * The rule at the door protects a business from today onwards and does
   * nothing for the six months already in the books — which is where the
   * duplicate that gets paid twice actually is, because nothing has looked.
   */
  it('finds a pair and names both', async () => {
    const vendor = await aVendor('Northern Supplies')
    const first = await aBill(vendor.id)
    const second = await aBill(vendor.id, { acknowledgeDuplicate: true })

    const pairs = await suspectedDuplicateBills(fixture.ctx)

    expect(pairs).toHaveLength(1)
    expect(pairs[0].keptId).toBe(first.id)
    expect(pairs[0].suspectId).toBe(second.id)
    expect(pairs[0].vendorName).toBe('Northern Supplies')
  })

  it('is quiet on books with nothing to say', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor.id, { issueDate: '2026-01-01' })
    await aBill(vendor.id, { issueDate: '2026-06-01', totalCents: 44_000 })

    expect(await suspectedDuplicateBills(fixture.ctx)).toHaveLength(0)
  })

  /**
   * A voided bill is the *answer* to a duplicate rather than half of one.
   * Listing it sends somebody to look at a problem already dealt with.
   */
  it('forgets a pair once one of them is voided', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor.id)
    const second = await aBill(vendor.id, { acknowledgeDuplicate: true })

    expect(await suspectedDuplicateBills(fixture.ctx)).toHaveLength(1)

    await db.update(bills).set({ status: 'void' }).where(eq(bills.id, second.id))

    expect(await suspectedDuplicateBills(fixture.ctx)).toHaveLength(0)
  })

  it('reports what is still stoppable separately from the total', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor.id)
    await aBill(vendor.id, { acknowledgeDuplicate: true })

    const exposure = await duplicateExposure(fixture.ctx)

    expect(exposure.pairs).toBe(1)
    expect(exposure.totalCents).toBe(120_000)
    // Nothing has been paid, so all of it can still be stopped.
    expect(exposure.unpaidCents).toBe(120_000)
  })

  it('does not pair bills from different suppliers', async () => {
    const one = await aVendor('Northern Supplies')
    const two = await aVendor('Harbour Plant Hire')

    await aBill(one.id)
    await aBill(two.id)

    expect(await suspectedDuplicateBills(fixture.ctx)).toHaveLength(0)
  })
})

describe('the nightly check', () => {
  it('reports a suspected duplicate as a position, not a broken book', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor.id)
    await aBill(vendor.id, { acknowledgeDuplicate: true })

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row) => row.key === 'payables.duplicate_bills')

    expect(finding).toBeDefined()
    expect(finding!.agrees).toBe(false)
    expect(finding!.detail).toContain('1 pair')
    // A position. Alarming on a resemblance is how a check gets switched off.
    expect(run.faults).toBe(0)
  })

  it('agrees on books with no resemblances in them', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor.id, { vendorReference: 'INV-1' })
    await aBill(vendor.id, { vendorReference: 'INV-2', totalCents: 44_000 })

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row) => row.key === 'payables.duplicate_bills')

    expect(finding!.agrees).toBe(true)
    expect(finding!.detail).toBeNull()
  })
})

describe('two records for one supplier', () => {
  /**
   * Found in the browser, in this phase's own demo: the supplier dropdown
   * offered **Delta Electrical twice**. Not cosmetic — the duplicate-bill rule
   * is keyed on the vendor, so a supplier split across two records is invisible
   * to it, and the same invoice entered against each passes as "two suppliers
   * using the same number", which is the case this phase deliberately allows.
   */
  it('refuses a second supplier under a name already on the books', async () => {
    await aVendor('Delta Electrical')

    await expect(aVendor('delta  electrical')).rejects.toThrow(DocumentError)
  })

  it('names the record already there', async () => {
    await aVendor('Delta Electrical')

    let message = ''
    try {
      await aVendor('DELTA ELECTRICAL')
    } catch (error) {
      message = (error as DocumentError).message
    }

    expect(message).toContain('Delta Electrical')
    expect(message).toContain('split their balance')
  })

  /**
   * There is more than one "Smith & Sons". Refusing outright would leave
   * somebody unable to record a supplier who exists, which this phase holds to
   * be worse than a duplicate.
   */
  it('is a question, not a rule', async () => {
    await aVendor('Smith & Sons')

    let overridable = false
    try {
      await aVendor('Smith & Sons')
    } catch (error) {
      overridable = (error as DocumentError).overridable
    }
    expect(overridable).toBe(true)

    const second = await createVendor(fixture.ctx, {
      name: 'Smith & Sons',
      allowNamesake: true,
    })
    expect(second.id).toBeTruthy()
  })

  it('applies on the customer side too', async () => {
    await createCustomer(fixture.ctx, { name: 'Harborview Development LLC' })

    await expect(
      createCustomer(fixture.ctx, { name: 'harborview development llc' }),
    ).rejects.toThrow(DocumentError)
  })

  it('says nothing about a genuinely different name', async () => {
    await aVendor('Northern Supplies')
    const other = await aVendor('Northern Supply Co')
    expect(other.id).toBeTruthy()
  })
})

describe('normaliseName', () => {
  it('treats case and spacing as noise', () => {
    expect(normaliseName('Delta Electrical')).toBe(normaliseName('  delta   electrical '))
  })

  /**
   * Punctuation is kept. "Smith & Sons" and "Smith and Sons" being told apart
   * matters less than "A.B.C." and "ABC" being told apart, and stripping it
   * would start refusing names that are genuinely different.
   */
  it('keeps punctuation, which is part of a name', () => {
    expect(normaliseName('A.B.C.')).not.toBe(normaliseName('ABC'))
  })

  it('finds nothing in an empty list, or for an empty name', () => {
    expect(namesakeOf('Anyone', [])).toBeNull()
    expect(namesakeOf('   ', [{ id: 'a', name: '' }])).toBeNull()
  })
})
