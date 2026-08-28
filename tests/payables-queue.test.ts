import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bills } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createBill, createVendor, recordPayment } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { createVendorCredit } from '@/modules/receivables/vendor-credits'
import { applyVendorCredit } from '@/modules/receivables/vendor-credits'
import {
  accountsWithBalances,
  billsByIds,
  openVendorCredits,
  payableQueue,
  totalPayable,
  vendorCreditBalances,
} from '@/modules/payables/queue'
import { applicationOrder, groupBySupplier, planRun } from '@/modules/payables/run'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'

/**
 * What you owe, and choosing what to pay (Phase 49).
 *
 * The claim under test: **the choice is respected absolutely.** A bill nobody
 * ticked is never touched — which is what oldest-first-across-everything could
 * not promise, and why a business disputing its two oldest invoices could not
 * pay the third.
 */

let fixture: Fixture
let expenseId: string
let bankId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Payables Co' })
  expenseId = (await fixture.account('6350')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
})

async function aVendor(name: string) {
  return (await createVendor(fixture.ctx, { name })).id
}

async function aBill(vendorId: string, cents: number, dueDate: string, issueDate = '2026-07-01') {
  return createBill(fixture.ctx, {
    vendorId,
    issueDate,
    dueDate,
    acknowledgeDuplicate: true,
    lines: [{ chartAccountId: expenseId, description: 'Supplies', unitPriceCents: cents }],
  })
}

const balanceOf = async (number: string) => {
  const account = await accountByNumber(fixture.companyId, number)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

describe('the queue', () => {
  it('is ordered by what has to be paid next, not by when it was raised', async () => {
    const vendor = await aVendor('Northern Supplies')

    // Raised first, but on ninety-day terms.
    await aBill(vendor, 50_000, '2026-11-01', '2026-08-01')
    // Raised later, due sooner.
    await aBill(vendor, 30_000, '2026-09-01', '2026-08-10')

    const queue = await payableQueue(fixture.ctx, { asOf: '2026-08-28' })

    expect(queue.map((row) => row.balanceCents)).toEqual([30_000, 50_000])
  })

  it('buckets each bill by how late it is', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor, 10_000, '2026-08-01')
    await aBill(vendor, 20_000, '2026-08-28')
    await aBill(vendor, 30_000, '2026-09-02')
    await aBill(vendor, 40_000, '2026-12-01')

    const queue = await payableQueue(fixture.ctx, { asOf: '2026-08-28' })

    expect(queue.map((row) => row.bucket)).toEqual(['overdue', 'due_now', 'due_soon', 'later'])
  })

  it('leaves out what is settled', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(vendor, 10_000, '2026-08-01')

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor,
      paymentDate: '2026-08-05',
      amountCents: 10_000,
      financialAccountId: bankId,
      applications: [{ billId: bill.id, amountCents: 10_000 }],
    })

    expect(await payableQueue(fixture.ctx)).toHaveLength(0)
    expect(await totalPayable(fixture.ctx)).toBe(0)
  })

  it('keeps a part-paid bill, at what is left', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(vendor, 10_000, '2026-08-01')

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor,
      paymentDate: '2026-08-05',
      amountCents: 4_000,
      financialAccountId: bankId,
      applications: [{ billId: bill.id, amountCents: 4_000 }],
    })

    const queue = await payableQueue(fixture.ctx)
    expect(queue).toHaveLength(1)
    expect(queue[0].balanceCents).toBe(6_000)
    expect(await totalPayable(fixture.ctx)).toBe(6_000)
  })

  it('shows what each bank account holds, as the ledger sees it', async () => {
    const accounts = await accountsWithBalances(fixture.ctx)
    const checking = accounts.find((row) => row.id === bankId)

    expect(checking).toBeDefined()
    expect(checking!.availableCents).toBe(0)
    expect(checking!.owingCents).toBeNull()
  })

  /**
   * Found in the browser. A card's balance is what the business **owes**, and
   * the screen said *"Business Credit Card holds $1,404.79 on the ledger.
   * $154.79 left afterwards"* — exactly backwards, so somebody reading it would
   * think they had headroom while paying $1,250 took the debt to $2,654.79.
   *
   * A card reports no available figure at all: its headroom is its limit less
   * its balance, and this system does not know the limit. Saying nothing is
   * the only honest answer.
   */
  it('never reports a credit card as money available', async () => {
    const card = await createFinancialAccount(fixture.ctx, {
      name: 'Business Credit Card',
      kind: 'credit_card',
      mask: '2210',
    })

    const accounts = await accountsWithBalances(fixture.ctx)
    const row = accounts.find((a) => a.id === card.id)!

    expect(row.availableCents).toBeNull()
    expect(row.owingCents).toBe(0)
  })

  /** A loan is a liability too, and gets the same treatment without a list. */
  it('treats a loan the same way', async () => {
    const loan = await createFinancialAccount(fixture.ctx, {
      name: 'Equipment Loan',
      kind: 'loan',
      mask: '0091',
    })

    const accounts = await accountsWithBalances(fixture.ctx)
    expect(accounts.find((a) => a.id === loan.id)!.availableCents).toBeNull()
  })

  /**
   * And the plan says nothing about coverage when there is no figure to
   * compare against, rather than treating null as zero and refusing.
   */
  it('says nothing about coverage when the account owes rather than holds', async () => {
    const verdict = planRun({
      chosen: [
        {
          id: 'a',
          number: 'BILL-1',
          vendorId: 'v',
          vendorName: 'V',
          dueDate: '2026-08-01',
          balanceCents: 500_000,
        },
      ],
      availableCents: null,
    })

    expect(verdict.covered).toBe(true)
    expect(verdict.warning).toBeNull()
  })
})

describe('paying what was chosen', () => {
  /**
   * The defect this phase closes. A business disputing its two oldest invoices
   * and paying the third could not: `allocate` consumed oldest first across
   * everything open, so the money settled the disputed bills.
   */
  it('leaves the bills nobody ticked completely alone', async () => {
    const vendor = await aVendor('Northern Supplies')
    const disputed = await aBill(vendor, 50_000, '2026-06-01')
    const alsoDisputed = await aBill(vendor, 30_000, '2026-07-01')
    const agreed = await aBill(vendor, 20_000, '2026-08-01')

    const chosen = await billsByIds(fixture.ctx, [agreed.id])
    expect(chosen).toHaveLength(1)

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor,
      paymentDate: '2026-08-28',
      amountCents: 20_000,
      financialAccountId: bankId,
      applications: chosen.map((bill) => ({ billId: bill.id, amountCents: bill.balanceCents })),
    })

    const [one] = await db.select().from(bills).where(eq(bills.id, disputed.id))
    const [two] = await db.select().from(bills).where(eq(bills.id, alsoDisputed.id))
    const [three] = await db.select().from(bills).where(eq(bills.id, agreed.id))

    expect(one.balanceCents).toBe(50_000)
    expect(two.balanceCents).toBe(30_000)
    expect(three.balanceCents).toBe(0)
    expect(three.status).toBe('paid')
  })

  /**
   * One payment per supplier, not one per bill — a business paying four of a
   * supplier's invoices writes one cheque, and the bank statement shows one
   * line.
   */
  it('is one payment per supplier, however many bills it covers', async () => {
    const northern = await aVendor('Northern Supplies')
    const harbour = await aVendor('Harbour Plant Hire')

    await aBill(northern, 50_000, '2026-08-01')
    await aBill(northern, 30_000, '2026-08-10')
    await aBill(harbour, 20_000, '2026-08-05')

    const queue = await payableQueue(fixture.ctx)
    const groups = groupBySupplier(queue)

    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.vendorId === northern)!.totalCents).toBe(80_000)
  })

  it('applies the oldest of the chosen bills first', async () => {
    const vendor = await aVendor('Northern Supplies')
    await aBill(vendor, 50_000, '2026-09-01')
    await aBill(vendor, 30_000, '2026-07-01')

    const ordered = applicationOrder(await payableQueue(fixture.ctx))
    expect(ordered.map((row) => row.dueDate)).toEqual(['2026-07-01', '2026-09-01'])
  })

  it('only ever returns bills on these books', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const theirVendor = (await createVendor(other.ctx, { name: 'Theirs' })).id
    const theirExpense = (await other.account('6350')).id
    const theirBill = await createBill(other.ctx, {
      vendorId: theirVendor,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: theirExpense, description: 'x', unitPriceCents: 1_000 }],
    })

    expect(await billsByIds(fixture.ctx, [theirBill.id])).toHaveLength(0)
  })
})

describe('a vendor credit', () => {
  /**
   * `applyVendorCredit` and its server action have existed since Phase 12 with
   * no caller anywhere in `src/app`, so a credit with anything left after the
   * bill it was raised against was stranded for ever. The screen showed the
   * remaining balance beside no control at all.
   */
  it('is offered beside what is owed to that supplier', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(vendor, 50_000, '2026-08-01')
    await aBill(vendor, 30_000, '2026-08-10')

    await createVendorCredit(fixture.ctx, {
      vendorId: vendor,
      billId: bill.id,
      issueDate: '2026-08-12',
      reason: 'Two pallets returned',
    })

    const balances = await vendorCreditBalances(fixture.ctx)
    expect(balances.get(vendor)).toBe(50_000)

    const queue = await payableQueue(fixture.ctx)
    expect(queue.every((row) => row.vendorCreditCents === 50_000)).toBe(true)
  })

  it('can be spent against another of that supplier’s bills', async () => {
    const vendor = await aVendor('Northern Supplies')
    const first = await aBill(vendor, 50_000, '2026-08-01')
    const second = await aBill(vendor, 30_000, '2026-08-10')

    const credit = await createVendorCredit(fixture.ctx, {
      vendorId: vendor,
      billId: first.id,
      issueDate: '2026-08-12',
      reason: 'Two pallets returned',
    })

    // Raising the credit is what moved the ledger: Dr Accounts Payable,
    // Cr the accounts the bill was coded to. Two bills of 80,000 less a
    // credit of 50,000.
    const before = await balanceOf('2000')
    expect(before).toBe(30_000)

    await applyVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      billId: second.id,
      amountCents: 30_000,
      appliedOn: '2026-08-28',
    })

    const [row] = await db.select().from(bills).where(eq(bills.id, second.id))
    expect(row.balanceCents).toBe(0)
    expect(row.status).toBe('paid')

    /**
     * And **the ledger does not move again**, which is the subtle part.
     *
     * Applying a credit is a subledger allocation — it says which bill the
     * credit settles. The general ledger was adjusted when the credit note was
     * raised, and posting a second entry here would take the same cost out of
     * Accounts Payable twice. Asserted rather than assumed, because the
     * plausible-looking mistake is to expect a posting.
     */
    expect(await balanceOf('2000')).toBe(before)

    const left = await openVendorCredits(fixture.ctx)
    expect(left.find((r) => r.id === credit.id)?.remainingCents).toBe(20_000)
  })

  it('disappears from the list once it is used up', async () => {
    const vendor = await aVendor('Northern Supplies')
    const first = await aBill(vendor, 50_000, '2026-08-01')
    const second = await aBill(vendor, 50_000, '2026-08-10')

    const credit = await createVendorCredit(fixture.ctx, {
      vendorId: vendor,
      billId: first.id,
      issueDate: '2026-08-12',
      reason: 'Returned',
    })

    await applyVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      billId: second.id,
      amountCents: 50_000,
      appliedOn: '2026-08-28',
    })

    expect(await openVendorCredits(fixture.ctx)).toHaveLength(0)
    expect((await vendorCreditBalances(fixture.ctx)).get(vendor)).toBeUndefined()
  })
})
