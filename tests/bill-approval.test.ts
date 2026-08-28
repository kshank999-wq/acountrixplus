import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, bills } from '@/db/schema'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'
import { createBill, createVendor, recordPayment } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import {
  approveBill,
  payablesPolicy,
  updatePayablesPolicy,
  withdrawApproval,
} from '@/modules/payables/approvals-service'
import { splitByApproval } from '@/modules/payables/approval'
import { billsByIds, payableQueue } from '@/modules/payables/queue'
import type { ActorContext } from '@/modules/tenancy/context'

/**
 * The payment nobody approved (Phase 50).
 *
 * The claim under test: **one person cannot create a supplier, bill it and pay
 * it.** They could — with `accounting:journal` alone, and Phase 49 turned the
 * last step into one click across a whole batch. Nothing recorded who entered
 * a bill, so there was nowhere for a second pair of eyes to appear.
 */

let fixture: Fixture
/** Has no approval permission at all. */
let bookkeeper: ActorContext
/** Enters the bills. */
let enterer: ActorContext
/** Somebody else who may approve. */
let approver: ActorContext
let expenseId: string
let bankId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Approvals Co' })
  bookkeeper = await addUserWithRole(fixture, 'bookkeeper')
  enterer = await addUserWithRole(fixture, 'accountant')
  approver = await addUserWithRole(fixture, 'accountant')
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

async function aBill(ctx: ActorContext, vendorId: string, cents: number) {
  return createBill(ctx, {
    vendorId,
    issueDate: '2026-08-01',
    dueDate: '2026-08-28',
    acknowledgeDuplicate: true,
    lines: [{ chartAccountId: expenseId, description: 'Supplies', unitPriceCents: cents }],
  })
}

describe('the policy', () => {
  /**
   * Off unless somebody turns it on. A sole trader is their own bookkeeper and
   * their own approver, and a system that ships this on has shipped a feature
   * most of its users must immediately switch off.
   */
  it('asks for nothing until a company agrees to it', async () => {
    const policy = await payablesPolicy(fixture.companyId)

    expect(policy.enabled).toBe(false)
  })

  it('remembers what a company decided', async () => {
    await updatePayablesPolicy(fixture.ctx, { enabled: true, thresholdCents: 250_00 })

    const policy = await payablesPolicy(fixture.companyId)
    expect(policy.enabled).toBe(true)
    expect(policy.thresholdCents).toBe(250_00)
    // Untouched fields keep what they had rather than reverting to a default.
    expect(policy.twoPersonRule).toBe(true)
  })

  /**
   * Switching the control off is itself a control decision, so it needs
   * `accounting:approve` rather than any lesser permission. Somebody who can
   * disable approvals is not subject to them.
   */
  it('cannot be switched off by somebody who cannot approve', async () => {
    await expect(updatePayablesPolicy(bookkeeper, { enabled: false })).rejects.toThrow()
  })

  it('records the change, so switching it off is visible afterwards', async () => {
    await updatePayablesPolicy(fixture.ctx, { enabled: true, thresholdCents: 100_00 })
    await updatePayablesPolicy(fixture.ctx, { enabled: false })

    const entries = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'payables.policy'))

    expect(entries.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * **Found in the browser.** Ticking "Require approval" and nothing else used
   * `APPROVAL_OFF` as its baseline — whose threshold is zero, because nothing
   * reads it while the control is off. So the first save wrote **zero**, and
   * every bill, down to a £4 parking receipt, suddenly needed a second person:
   * exactly the rule this module warns is worse than no rule at all. It also
   * silently overrode the $1,000 the schema had chosen.
   */
  it('starts a company on a sensible threshold rather than zero', async () => {
    await updatePayablesPolicy(fixture.ctx, { enabled: true })

    const policy = await payablesPolicy(fixture.companyId)
    expect(policy.enabled).toBe(true)
    expect(policy.thresholdCents).toBe(100_000)
  })

  it('refuses a negative threshold', async () => {
    await expect(
      updatePayablesPolicy(fixture.ctx, { thresholdCents: -1 }),
    ).rejects.toThrow(/negative/i)
  })
})

describe('who entered a bill', () => {
  /**
   * There was nowhere for this to be recorded before Phase 50, which is why
   * there was nowhere for a second pair of eyes to appear either.
   */
  it('is on the bill', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id))
    expect(row.enteredBy).toBe(enterer.userId)
    expect(row.approvedBy).toBeNull()
  })
})

describe('approving', () => {
  beforeEach(async () => {
    await updatePayablesPolicy(fixture.ctx, { enabled: true, thresholdCents: 100_00 })
  })

  /**
   * The substance of the phase. One person creating a supplier, billing it and
   * paying it is how money leaves a business without anybody noticing.
   */
  it('is refused to the person who entered it', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    await expect(approveBill(enterer, bill.id)).rejects.toThrow(
      /somebody else has to approve it/,
    )
  })

  /**
   * `accounting:approve` is its own permission, not a fold into
   * `accounting:journal`. Today the roster gives both to the same roles, so the
   * two-person rule above is what actually separates entering from approving —
   * but the seam matters: a company granting a colleague `accounting:journal`
   * as a per-membership override does not thereby hand them the approval.
   */
  it('is refused to somebody without the approval permission', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    await expect(approveBill(bookkeeper, bill.id)).rejects.toThrow()
  })

  it('is allowed to anybody else who may approve', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    const result = await approveBill(approver, bill.id)
    expect(result.number).toBe(bill.number)

    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id))
    expect(row.approvedBy).toBe(approver.userId)
    expect(row.approvedAt).not.toBeNull()
  })

  it('happens once, however many people press at the same moment', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    const results = await Promise.allSettled([
      approveBill(approver, bill.id),
      approveBill(fixture.ctx, bill.id),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  /**
   * A bill raised before Phase 50 has no `enteredBy` — the migration
   * deliberately does not backfill one, because inventing a name would put a
   * person against a decision they may never have made. The two-person rule
   * stands aside rather than leaving those unapprovable for ever.
   */
  it('allows a bill nobody is recorded as having entered', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    await db.update(bills).set({ enteredBy: null }).where(eq(bills.id, bill.id))

    // The person who *did* enter it, now unrecorded. Nothing to compare, so
    // the rule stands aside rather than leaving the bill unapprovable for ever.
    await expect(approveBill(enterer, bill.id)).resolves.toBeTruthy()
  })

  it('leaves the small ones alone', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 40_00)

    await expect(approveBill(approver, bill.id)).rejects.toThrow(/below the amount/)
  })

  /**
   * Whose work an approver is agreeing to, on the row. That is the whole
   * substance of the two-person rule, so the queue carries the name rather
   * than making somebody go and look it up.
   */
  it('says who entered each bill on the queue itself', async () => {
    const vendor = await aVendor('Northern Supplies')
    const big = await aBill(enterer, vendor, 500_00)

    const queue = await payableQueue(fixture.ctx)
    const row = queue.find((r) => r.id === big.id)!

    expect(row.enteredBy).toBe(enterer.userId)
    expect(row.enteredByName).toBe(enterer.userName)
  })

  it('only ever touches bills on these books', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const theirVendor = (await createVendor(other.ctx, { name: 'Theirs' })).id
    const theirExpense = (await other.account('6350')).id
    const theirBill = await createBill(other.ctx, {
      vendorId: theirVendor,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: theirExpense, description: 'x', unitPriceCents: 500_00 }],
    })

    await expect(approveBill(approver, theirBill.id)).rejects.toThrow(/not on these books/)
  })
})

describe('taking an approval back', () => {
  beforeEach(async () => {
    await updatePayablesPolicy(fixture.ctx, { enabled: true, thresholdCents: 100_00 })
  })

  it('is allowed while nothing has been paid', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    await approveBill(approver, bill.id)
    await withdrawApproval(approver, bill.id)

    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id))
    expect(row.approvedBy).toBeNull()
    expect(row.approvedAt).toBeNull()
  })

  /**
   * An approval is a statement that money may leave. Once it has left,
   * withdrawing the statement changes nothing and leaves a paid bill reading as
   * though it was never authorised — a worse record than the truth.
   */
  it('is refused once any of the money has gone', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)
    await approveBill(approver, bill.id)

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor,
      paymentDate: '2026-08-28',
      amountCents: 100_00,
      financialAccountId: bankId,
      applications: [{ billId: bill.id, amountCents: 100_00 }],
    })

    await expect(withdrawApproval(approver, bill.id)).rejects.toThrow(/already been paid/)
  })

  it('says so when there was no approval to take back', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 500_00)

    await expect(withdrawApproval(approver, bill.id)).rejects.toThrow(/has not been approved/)
  })
})

describe('a pay run meeting an unapproved bill', () => {
  /**
   * Held back, not refused. Somebody ticking eight bills of which one needs
   * approving should get the seven paid and be told about the eighth —
   * refusing the lot teaches them to switch approvals off, which is the
   * opposite of what the control is for.
   *
   * Read through `billsByIds`, the query the run itself uses, so the columns
   * the rule depends on are proved to reach it.
   */
  it('pays the rest and holds the one back', async () => {
    await updatePayablesPolicy(fixture.ctx, { enabled: true, thresholdCents: 100_00 })

    const vendor = await aVendor('Northern Supplies')
    const small = await aBill(enterer, vendor, 40_00)
    const big = await aBill(enterer, vendor, 500_00)
    const agreed = await aBill(enterer, vendor, 900_00)
    await approveBill(approver, agreed.id)

    const chosen = await billsByIds(fixture.ctx, [small.id, big.id, agreed.id])
    const policy = await payablesPolicy(fixture.companyId)
    const split = splitByApproval(chosen, policy)

    expect(split.payable.map((row) => row.id).sort()).toEqual([small.id, agreed.id].sort())
    expect(split.held.map((row) => row.id)).toEqual([big.id])
  })

  it('holds nothing back while approvals are off', async () => {
    const vendor = await aVendor('Northern Supplies')
    const bill = await aBill(enterer, vendor, 900_00)

    const chosen = await billsByIds(fixture.ctx, [bill.id])
    const split = splitByApproval(chosen, await payablesPolicy(fixture.companyId))

    expect(split.held).toHaveLength(0)
    expect(split.payable).toHaveLength(1)
  })
})
