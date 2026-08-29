import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customerStatements, invoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { sendInvoice } from '@/modules/receivables/send'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { updateChasePolicy } from '@/modules/receivables/chase-policy'
import { previewChases } from '@/modules/receivables/chase-run'
import { applyCredit } from '@/modules/receivables/customer-credit'
import { voidPayment } from '@/modules/receivables/payment-voiding'
import {
  buildStatement,
  customersWithBalances,
  listStatements,
  saveStatement,
} from '@/modules/receivables/statements'

/**
 * The letter that asks for money we are holding (Phase 54).
 *
 * Two claims under test, and both were **made wrong by Phase 53** rather than
 * being wrong before it:
 *
 *  1. **A customer whose money the business is holding is not chased.** Phase
 *     43's design is that these letters go out without anybody deciding again,
 *     which is exactly what makes a wrong one serious.
 *  2. **A statement nets the credit off**, and says so. A customer holding
 *     $600 against a $900 invoice was being sent a document claiming $900 —
 *     one they could disprove from their own bank records.
 *
 * The decision itself is asserted in `net-position.test.ts` with no database.
 * What is under test here is the half that touches the world: that the run and
 * the statement actually read what is held.
 */

let fixture: Fixture
let bankId: string
let revenueId: string
let customerId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Chase Co' })
  revenueId = (await fixture.account('4000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
  customerId = (
    await createCustomer(fixture.ctx, {
      name: 'Meridian Facilities Ltd',
      email: 'accounts@meridian.test',
    })
  ).id
})

async function anOverdueInvoice(cents: number, forCustomerId = customerId) {
  const invoice = await createInvoice(fixture.ctx, {
    customerId: forCustomerId,
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    lines: [{ chartAccountId: revenueId, description: 'Survey', unitPriceCents: cents }],
  })

  // A chase can only follow a first send: you cannot remind somebody of
  // something you never told them. The stamp is moved back because
  // `sendInvoice` uses the real clock, which is later than every `asOf` here —
  // without it the gap rule correctly refuses to chase anything at all.
  await sendInvoice(fixture.ctx, invoice.id)
  await db
    .update(invoices)
    .set({ sentAt: new Date('2026-02-01T00:00:00Z') })
    .where(eq(invoices.id, invoice.id))

  return invoice
}

/** An advance with nothing to apply it to, which is the simplest held credit. */
async function anAdvance(cents: number) {
  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-02-01',
    amountCents: cents,
    financialAccountId: bankId,
    applications: [],
  })
}

/** What a run today would do, asked through the same function the worker uses. */
async function planFor(asOf: string) {
  await updateChasePolicy(fixture.ctx, { enabled: true })
  return previewChases(fixture.companyId, asOf)
}

describe('chasing a customer whose money we are holding', () => {
  /**
   * The substance of the phase. Before it, this run would have emailed a
   * demand for $900 to somebody who had just sent $600 too much.
   */
  it('does not go out', async () => {
    await anOverdueInvoice(90_000)
    await anAdvance(60_000)

    const plan = await planFor('2026-06-01')

    expect(plan.due).toHaveLength(0)
    expect(plan.held.map((row) => row.reason)).toEqual(['holding_their_money'])
  })

  /**
   * Even when the credit is far smaller than the debt — the rule is decided on
   * the customer's whole position, not invoice by invoice.
   */
  it('does not go out for a credit of one cent', async () => {
    await anOverdueInvoice(90_000)
    await anAdvance(1)

    expect((await planFor('2026-06-01')).due).toHaveLength(0)
  })

  /**
   * And resumes with nothing changed once the credit is gone. The rule is a
   * pause while somebody decides where the money belongs, not a permanent
   * exemption.
   */
  it('resumes once the credit is spent', async () => {
    const invoice = await anOverdueInvoice(90_000)
    const advance = await anAdvance(60_000)

    expect((await planFor('2026-06-01')).due).toHaveLength(0)

    await applyCredit(fixture.ctx, {
      paymentId: advance.id,
      invoiceId: invoice.id,
      appliedOn: '2026-02-02',
    })

    const after = await planFor('2026-06-01')
    expect(after.due).toHaveLength(1)
    expect(after.due[0].invoice.balanceCents).toBe(30_000)
  })

  it('chases normally when nothing is held', async () => {
    await anOverdueInvoice(90_000)

    expect((await planFor('2026-06-01')).due).toHaveLength(1)
  })

  /**
   * The preview's whole job is to say *why* the others are not going out
   * (Phase 43), so the new reason has to reach it with a sentence attached.
   */
  it('says why, on the preview', async () => {
    await anOverdueInvoice(90_000)
    await anAdvance(60_000)

    const preview = await planFor('2026-06-01')

    expect(preview.heldCounts.holding_their_money).toBe(1)
    expect(preview.held.map((row) => row.reason)).toContain('holding_their_money')
  })

  /** A voided receipt holds nothing, so the chase resumes (Phase 52). */
  it('resumes once the receipt that held it is voided', async () => {
    await anOverdueInvoice(90_000)
    const advance = await anAdvance(60_000)

    expect((await planFor('2026-06-01')).due).toHaveLength(0)

    await voidPayment(fixture.ctx, { paymentId: advance.id, reason: 'Never cleared' })

    expect((await planFor('2026-06-01')).due).toHaveLength(1)
  })

  /** One customer's credit does not quiet another customer's chase. */
  it('leaves another customer’s invoice alone', async () => {
    await anOverdueInvoice(90_000)
    await anAdvance(60_000)

    const other = await createCustomer(fixture.ctx, {
      name: 'Somebody Else Ltd',
      email: 'ap@else.test',
    })
    const theirs = await anOverdueInvoice(50_000, other.id)

    const plan = await planFor('2026-06-01')

    expect(plan.due).toHaveLength(1)
    expect(plan.due[0].invoice.id).toBe(theirs.id)
  })
})

describe('the statement a customer receives', () => {
  /**
   * A statement claiming $900 from somebody the business owes $600 is a
   * document they can disprove from their own bank records.
   */
  it('nets the credit off, and says so', async () => {
    await anOverdueInvoice(90_000)
    await anAdvance(60_000)

    const statement = await buildStatement(fixture.ctx, {
      customerId,
      asOfDate: '2026-06-30',
    })

    // The gross is kept, because a customer reconciling against their own
    // purchase ledger needs to see what was billed.
    expect(statement.closingBalanceCents).toBe(90_000)
    expect(statement.heldCreditCents).toBe(60_000)
    expect(statement.dueCents).toBe(30_000)
    expect(statement.positionNote).toContain('$300.00 is due')
    expect(statement.positionNote).toContain('$600.00 we are holding')
  })

  it('says nothing is due when the credit covers it', async () => {
    await anOverdueInvoice(60_000)
    await anAdvance(60_000)

    const statement = await buildStatement(fixture.ctx, {
      customerId,
      asOfDate: '2026-06-30',
    })

    expect(statement.dueCents).toBe(0)
    expect(statement.ourDebtCents).toBe(0)
    expect(statement.positionNote).toContain('Nothing is due')
  })

  /** And says out loud when the business is the one in debt. */
  it('says what is still theirs when the credit runs past the debt', async () => {
    await anOverdueInvoice(40_000)
    await anAdvance(100_000)

    const statement = await buildStatement(fixture.ctx, {
      customerId,
      asOfDate: '2026-06-30',
    })

    expect(statement.dueCents).toBe(0)
    expect(statement.ourDebtCents).toBe(60_000)
    expect(statement.positionNote).toContain('still yours')
  })

  /**
   * A receipt that arrived after the statement date did not reduce what was due
   * on it, the same way an invoice raised afterwards is not on it.
   */
  it('ignores a receipt that had not arrived yet', async () => {
    await anOverdueInvoice(90_000)
    await anAdvance(60_000) // 2026-02-01

    const statement = await buildStatement(fixture.ctx, {
      customerId,
      asOfDate: '2026-01-15',
    })

    expect(statement.heldCreditCents).toBe(0)
    expect(statement.dueCents).toBe(statement.closingBalanceCents)
  })

  it('reads exactly as before when nothing is held', async () => {
    await anOverdueInvoice(90_000)

    const statement = await buildStatement(fixture.ctx, {
      customerId,
      asOfDate: '2026-06-30',
    })

    expect(statement.heldCreditCents).toBe(0)
    expect(statement.dueCents).toBe(90_000)
    expect(statement.positionNote).toBe('$900.00 is due.')
  })

  /**
   * Frozen with the rest of the figures. A statement sent in March has to
   * still say in July what it said in March — including how much of the
   * customer's money was being held at the time, which is what they would ring
   * up about.
   */
  it('freezes the held figure on a saved statement', async () => {
    const invoice = await anOverdueInvoice(90_000)
    const advance = await anAdvance(60_000)

    const saved = await saveStatement(fixture.ctx, { customerId, asOfDate: '2026-06-30' })

    await applyCredit(fixture.ctx, {
      paymentId: advance.id,
      invoiceId: invoice.id,
      appliedOn: '2026-07-01',
    })

    // The saved statement still says what it said.
    const figures = saved.figures as { heldCreditCents: number; dueCents: number }
    expect(figures.heldCreditCents).toBe(60_000)
    expect(figures.dueCents).toBe(30_000)

    // And the list reads it back out of the frozen figures rather than asking
    // the books again — which would now answer zero, having just been spent.
    const [listed] = await listStatements(fixture.ctx, { customerId })
    expect(listed.heldCreditCents).toBe(60_000)
    expect(listed.dueCents).toBe(30_000)
  })

  /**
   * A statement saved before Phase 54 has no held figure in it. It should read
   * as a plain gross balance, which is what it was.
   */
  it('reads an older statement as a plain balance', async () => {
    await anOverdueInvoice(90_000)
    const saved = await saveStatement(fixture.ctx, { customerId, asOfDate: '2026-06-30' })

    await db
      .update(customerStatements)
      .set({ figures: { lines: [], aging: {}, oldestUnpaidDate: null } })
      .where(eq(customerStatements.id, saved.id))

    const [listed] = await listStatements(fixture.ctx, { customerId })
    expect(listed.heldCreditCents).toBe(0)
    expect(listed.dueCents).toBe(90_000)
    expect(listed.positionNote).toBeNull()
  })
})

describe('the customer picker', () => {
  /**
   * Said where somebody choosing who to send a statement to will see it: they
   * are the one who can decide where the credit belongs before it goes out.
   */
  it('says what is being held, per customer', async () => {
    await anOverdueInvoice(90_000)
    await anAdvance(60_000)

    const other = await createCustomer(fixture.ctx, { name: 'Nothing Held Ltd' })

    const rows = await customersWithBalances(fixture.ctx)
    const mine = rows.find((row) => row.id === customerId)
    const theirs = rows.find((row) => row.id === other.id)

    expect(Number(mine?.heldCreditCents)).toBe(60_000)
    expect(Number(theirs?.heldCreditCents)).toBe(0)
  })

  /**
   * Counted once, not once per open invoice. A left join onto the same grouped
   * rows as `invoices` would have multiplied it, which is why it is a subquery.
   */
  it('counts a credit once however many invoices are open', async () => {
    await anOverdueInvoice(30_000)
    await anOverdueInvoice(40_000)
    await anOverdueInvoice(50_000)
    await anAdvance(60_000)

    const rows = await customersWithBalances(fixture.ctx)
    const mine = rows.find((row) => row.id === customerId)

    expect(Number(mine?.heldCreditCents)).toBe(60_000)
    expect(Number(mine?.balanceCents)).toBe(120_000)
  })
})
