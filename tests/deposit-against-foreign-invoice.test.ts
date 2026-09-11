import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, invoices, journalEntries, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { createProperty, createUnit, createLease } from '@/modules/properties/service'
import { applyDeposit, depositPosition, receiveDeposit } from '@/modules/properties/deposits'
import { putRate } from '@/modules/fx/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { trialBalance } from '@/modules/ledger/balances'
import { setModuleEnabled } from '@/modules/industry/modules'

/**
 * A deposit spent against a foreign invoice (Phase 138).
 *
 * A tenant's security deposit is held in the company's own money —
 * `deposit_movements` has no currency column — and `applyDeposit` takes any
 * `invoiceId` and asks it nothing. One number did both jobs.
 *
 * €1,000 of an invoice raised at 1.10 is worth $1,100.
 */

let fixture: Fixture
let leaseId: string
let tenantId: string
let revenueId: string

const RATE = 1_100_000
const FACE = 100_000
const WORTH = 110_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Ridge Property Co', industry: 'real_estate' })
  await setModuleEnabled(fixture.ctx, 'properties', true)
  revenueId = (await fixture.account('4000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-03-01',
    rateMillionths: RATE,
    source: 'manual',
  })

  const property = await createProperty(fixture.ctx, {
    code: 'ELM',
    name: 'Elm Street Apartments',
    city: 'Portland',
  })
  const unit = await createUnit(fixture.ctx, {
    propertyId: property.id,
    code: '1A',
    marketRentCents: 150_000,
  })
  const tenant = await createCustomer(fixture.ctx, { name: 'Sam Reyes' })
  tenantId = tenant.id

  const lease = await createLease(fixture.ctx, {
    unitId: unit.id,
    customerId: tenant.id,
    startsOn: '2026-01-01',
    endsOn: null,
    rentCents: 150_000,
    depositRequiredCents: 150_000,
    activate: true,
  })
  leaseId = lease.id
})

/** Somebody else's money, held in the company's own currency. */
async function held(amountCents: number) {
  await receiveDeposit(fixture.ctx, {
    leaseId,
    amountCents,
    occurredOn: '2026-01-05',
    financialAccountId: fixture.financialAccountId,
  })
}

/** A euro invoice for the same tenant. */
async function euroInvoice(faceCents: number) {
  return createInvoice(fixture.ctx, {
    customerId: tenantId,
    issueDate: '2026-03-01',
    dueDate: '2026-04-01',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Fit-out', unitPriceCents: faceCents }],
  })
}

async function receivableLines(): Promise<{ debitCents: number; creditCents: number }[]> {
  const [control] = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, '1100')))

  const rows = await db
    .select({
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
      sourceType: journalEntries.sourceType,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, fixture.companyId),
        eq(journalEntries.sourceType, 'lease_deposit'),
        eq(journalLines.chartAccountId, control.id),
      ),
    )

  return rows.map((row) => ({ debitCents: row.debitCents, creditCents: row.creditCents }))
}

describe('what the deposit gives up', () => {
  it('credits the receivable with what the invoice was carried at', async () => {
    // The defect. The subledger comes down by $1,100 — `relieveFunctional` at
    // the invoice's own rate — and the ledger was credited with 100000, the
    // raw euro figure. A face amount in a functional ledger, which is Phase
    // 127's defect where its scan did not reach.
    await held(150_000)
    const invoice = await euroInvoice(FACE)

    await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: FACE,
      occurredOn: '2026-03-15',
      invoiceId: invoice.id,
    })

    const lines = await receivableLines()
    expect(lines.length).toBe(1)
    expect(lines[0].creditCents).toBe(WORTH)
  })

  it('leaves the control account agreeing with the subledger', async () => {
    await held(150_000)
    const invoice = await euroInvoice(FACE)

    await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: FACE,
      occurredOn: '2026-03-15',
      invoiceId: invoice.id,
    })

    const after = await controlAccounts(fixture.ctx, {})
    expect(after.receivables.agrees).toBe(true)
    expect(after.receivables.ledgerCents).toBe(0)

    const [settled] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(settled.balanceCents).toBe(0)
    expect(settled.functionalBalanceCents).toBe(0)
  })

  it('takes the worth out of the tenancy, not the face amount', async () => {
    // What the tenant is owed back afterwards. Spending $1,100 of their money
    // and recording $1,000 spent would leave the landlord holding a hundred
    // dollars that is not theirs.
    await held(150_000)
    const invoice = await euroInvoice(FACE)

    await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: FACE,
      occurredOn: '2026-03-15',
      invoiceId: invoice.id,
    })

    const position = await depositPosition(fixture.ctx, leaseId)
    expect(position.heldCents).toBe(150_000 - WORTH)
  })

  it('keeps the books balanced', async () => {
    await held(150_000)
    const invoice = await euroInvoice(FACE)

    await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: FACE,
      occurredOn: '2026-03-15',
      invoiceId: invoice.id,
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(balances.isBalanced).toBe(true)
  })
})

describe('the permission that compared two currencies', () => {
  it('refuses a deposit that covers the face amount but not its worth', async () => {
    // **The sharpest half.** $1,050 held, €1,000 applied. The old check asked
    // `100000 > 105000`, which is false, so it went ahead — and spent $1,100
    // of a $1,050 deposit. Two currencies in one comparison (Phase 122), in
    // the check deciding whether somebody else's money may be spent.
    await held(105_000)
    const invoice = await euroInvoice(FACE)

    await expect(
      applyDeposit(fixture.ctx, {
        leaseId,
        amountCents: FACE,
        occurredOn: '2026-03-15',
        invoiceId: invoice.id,
      }),
    ).rejects.toThrow(/is held on this tenancy/)
  })

  it('says both figures in their own currencies', async () => {
    await held(105_000)
    const invoice = await euroInvoice(FACE)

    await expect(
      applyDeposit(fixture.ctx, {
        leaseId,
        amountCents: FACE,
        occurredOn: '2026-03-15',
        invoiceId: invoice.id,
      }),
    ).rejects.toThrow(/€1,000\.00/)
  })

  it('allows exactly enough', async () => {
    await held(WORTH)
    const invoice = await euroInvoice(FACE)

    await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: FACE,
      occurredOn: '2026-03-15',
      invoiceId: invoice.id,
    })

    const position = await depositPosition(fixture.ctx, leaseId)
    expect(position.heldCents).toBe(0)
  })
})

describe('a domestic invoice, which is every tenancy so far', () => {
  it('behaves exactly as it did', async () => {
    // Why this went unnoticed: with one currency the face amount and its worth
    // are the same number, so using either was right.
    await held(150_000)

    const invoice = await createInvoice(fixture.ctx, {
      customerId: tenantId,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      lines: [{ chartAccountId: revenueId, description: 'Fit-out', unitPriceCents: FACE }],
    })

    await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: FACE,
      occurredOn: '2026-03-15',
      invoiceId: invoice.id,
    })

    const lines = await receivableLines()
    expect(lines[0].creditCents).toBe(FACE)

    const position = await depositPosition(fixture.ctx, leaseId)
    expect(position.heldCents).toBe(150_000 - FACE)

    const after = await controlAccounts(fixture.ctx, {})
    expect(after.receivables.agrees).toBe(true)
  })

  it('still refuses more than is held', async () => {
    await held(100_000)

    const invoice = await createInvoice(fixture.ctx, {
      customerId: tenantId,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      lines: [{ chartAccountId: revenueId, description: 'Fit-out', unitPriceCents: 150_000 }],
    })

    await expect(
      applyDeposit(fixture.ctx, {
        leaseId,
        amountCents: 150_000,
        occurredOn: '2026-03-15',
        invoiceId: invoice.id,
      }),
    ).rejects.toThrow(/is held/i)
  })
})
