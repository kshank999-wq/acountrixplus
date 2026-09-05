import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, bills } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createBill, createVendor, voidDocument } from '@/modules/receivables/service'
import {
  approveBill,
  updatePayablesPolicy,
  withdrawApproval,
} from '@/modules/payables/approvals-service'
import {
  correction,
  everyCorrection,
  mustSayWhy,
  reasonFor,
} from '@/modules/corrections/vocabulary'

/**
 * Every correction says why, and says what it is (Phase 70).
 *
 * `voidPayment` insisted on a reason from Phase 52 and was the **only** one for
 * eighteen phases: `voidDocument`, `voidDeposit`, `withdrawApproval` and Phase
 * 69's own `voidRefund` all took none. Same reasoning, opposite behaviour by
 * screen.
 *
 * These are the service-level halves — that a reason given reaches the audit
 * trail at all. The rule about *which* corrections must carry one is decided in
 * `corrections/vocabulary` and enforced at the action layer, which is where the
 * screens meet it.
 */

let fixture: Fixture
let expenseId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Corrections Co' })
  expenseId = (await fixture.account('6000')).id

  // Approvals are off until a company decides otherwise, and withdrawing one
  // is only reachable once they are on. Phase 50's two-person rule is off here
  // because this fixture has one actor — it is not what these tests are about.
  await updatePayablesPolicy(fixture.ctx, {
    enabled: true,
    thresholdCents: 0,
    twoPersonRule: false,
  })
})

async function aBill() {
  const vendor = await createVendor(fixture.ctx, { name: 'Harborview Supply' })
  return createBill(fixture.ctx, {
    vendorId: vendor.id,
    issueDate: '2026-04-01',
    dueDate: '2026-05-01',
    lines: [{ chartAccountId: expenseId, description: 'Parts', unitPriceCents: 100_000 }],
  })
}

async function auditFor(action: string, entityId: string) {
  const [row] = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)))
  return row
}

describe('a correction that reached somebody outside', () => {
  /**
   * Cancelling a document is on the "must say why" side: the other party has
   * been sent it, and may be looking at it while you cancel.
   */
  it('keeps the reason a cancelled document was given', async () => {
    const bill = await aBill()

    await voidDocument(fixture.ctx, 'bill', bill.id, 'Duplicate of BILL-1001')

    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id))
    expect(row.status).toBe('void')

    const event = await auditFor('bill.void', bill.id)
    expect((event.after as { reason?: string }).reason).toBe('Duplicate of BILL-1001')
  })

  it('records a null rather than inventing one when none is given', async () => {
    const bill = await aBill()
    await voidDocument(fixture.ctx, 'bill', bill.id)

    const event = await auditFor('bill.void', bill.id)
    expect((event.after as { reason?: string | null }).reason).toBeNull()
  })
})

describe('a correction that only moves our own records', () => {
  /**
   * Withdrawing an approval posts nothing and can be re-done a minute later,
   * so a reason is welcome and not demanded — but one given is still kept.
   */
  it('keeps a reason given anyway', async () => {
    const bill = await aBill()
    await approveBill(fixture.ctx, bill.id)

    await withdrawApproval(fixture.ctx, bill.id, 'Wrong cost code')

    const event = await auditFor('bill.approval_withdraw', bill.id)
    expect((event.after as { reason?: string }).reason).toBe('Wrong cost code')
  })

  it('is happy without one', async () => {
    const bill = await aBill()
    await approveBill(fixture.ctx, bill.id)

    await expect(withdrawApproval(fixture.ctx, bill.id)).resolves.toBeTruthy()
  })

  /**
   * Found by this phase's own test, which asked for `bill.approve` after a
   * withdrawal and got the approval back. Withdrawing recorded itself under the
   * **same** action name as approving, distinguished only by a `withdrawn` flag
   * inside the payload — so "when was this approved" and "when was that taken
   * back" were one question with two answers, which is the defect this phase
   * exists to remove, sitting in the audit trail.
   */
  it('does not file taking an approval back under approving it', async () => {
    const bill = await aBill()
    await approveBill(fixture.ctx, bill.id)
    await withdrawApproval(fixture.ctx, bill.id, 'Wrong cost code')

    const approvals = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'bill.approve'), eq(auditEvents.entityId, bill.id)))

    expect(approvals).toHaveLength(1)
    expect((approvals[0].after as { reason?: string }).reason).toBeUndefined()
  })
})

describe('the rule they now share', () => {
  /** The defect: one phrase meaning four things across the screens. */
  it('gives every correction its own verb', () => {
    const verbs = everyCorrection().map((row) => row.verb)
    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('splits them the way the rule says, not by which screen they are on', () => {
    const must = everyCorrection().filter((row) => mustSayWhy(row.kind)).map((r) => r.kind).sort()
    const neednt = everyCorrection().filter((row) => !mustSayWhy(row.kind)).map((r) => r.kind).sort()

    // `posting.restate` joined the first list in Phase 130 without a line
    // being changed here, which is the point of writing `mustSayWhy` as
    // `reach !== 'internal'`: a fifth reach has to be argued into silence
    // rather than falling into it. `restates_the_past` was not, so it asks.
    expect(must).toEqual([
      'document.void',
      'party.merge',
      'payment.void',
      'posting.restate',
      'refund.void',
    ])
    expect(neednt).toEqual(['approval.withdraw', 'deposit.void'])
  })

  /**
   * Phase 96's clause, pinned on its own.
   *
   * A merge moves no money and sends no letter, so under the rule as Phase 70
   * wrote it the answer was `internal` — and `internal` means nobody is asked
   * why. The reason a merge is asked for is that it is the only surviving
   * record of why somebody believed two records were one business: afterwards
   * there is one record, and the question cannot be put again.
   */
  it('asks why for the one correction that cannot be taken back', () => {
    expect(correction('party.merge').reach).toBe('cannot_be_undone')
    expect(mustSayWhy('party.merge')).toBe(true)
    expect(reasonFor({ kind: 'party.merge', reason: '  ' }).ok).toBe(false)
  })
})
