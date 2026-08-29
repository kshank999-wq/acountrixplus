import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { journalLines, projects, retainers } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer } from '@/modules/receivables/service'
import { billWork, receiveRetainer } from '@/modules/timebilling/billing'
import { logTime, approveTime, setPersonRate } from '@/modules/timebilling/service'
import { putRate } from '@/modules/fx/service'
import { convert } from '@/modules/fx/rates'
import { trialBalance } from '@/modules/ledger/balances'
import { setModuleEnabled } from '@/modules/industry/modules'

/**
 * The retainer you could not draw (Phase 66).
 *
 * `refuseForeign` stopped this from Phase 35. ADR 0063 kept it deliberately and
 * ADR 0065 left it standing: a draw is a settlement, at a rate somebody had to
 * choose, with a real effect on reported profit.
 *
 * The answer is that neither rate needed choosing. The retainer has been
 * carried at the rate the money arrived at and the invoice at the rate it was
 * raised at, and the gap between them is the realised gain or loss
 * `recordPayment` has posted since Phase 35.
 */

let fixture: Fixture

/** 1.0835 when the money arrived; 1.10 when the work was billed. */
const ARRIVED = 1_083_500
const BILLED = 1_100_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Retainer Co', industry: 'professional_services' })
  await setModuleEnabled(fixture.ctx, 'time_billing', true)

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-04-01',
    rateMillionths: ARRIVED,
    source: 'manual',
  })
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: BILLED,
    source: 'manual',
  })
})

async function euroClient() {
  const customer = await createCustomer(fixture.ctx, { name: 'Bremen Beratung GmbH' })
  const [project] = await db
    .insert(projects)
    .values({ companyId: fixture.companyId, code: 'BREMEN-01', name: 'Advisory' })
    .returning()

  await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

  return { customer, project }
}

describe('taking a retainer in the client’s currency', () => {
  it('records what arrived and what it was worth', async () => {
    const { customer } = await euroClient()

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: customer.id,
      receivedOn: '2026-04-01',
      amountCents: 1_000_000,
      currency: 'EUR',
      financialAccountId: fixture.financialAccountId,
    })

    const [row] = await db.select().from(retainers).where(eq(retainers.id, retainer.id))
    expect(row.currency).toBe('EUR')
    expect(row.exchangeRateMillionths).toBe(ARRIVED)
    expect(row.remainingCents).toBe(1_000_000)
    expect(row.functionalRemainingCents).toBe(convert(1_000_000, ARRIVED))
  })

  /** The ledger is never in the client's money. */
  it('posts the receipt in the company’s own currency', async () => {
    const { customer } = await euroClient()

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: customer.id,
      receivedOn: '2026-04-01',
      amountCents: 1_000_000,
      currency: 'EUR',
      financialAccountId: fixture.financialAccountId,
    })

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, retainer.journalEntryId!))

    const debits = lines.reduce((sum, line) => sum + line.debitCents, 0)
    expect(debits).toBe(convert(1_000_000, ARRIVED))
  })

  it('leaves a domestic retainer exactly as it was', async () => {
    const { customer } = await euroClient()

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: customer.id,
      receivedOn: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })

    const [row] = await db.select().from(retainers).where(eq(retainers.id, retainer.id))
    expect(row.currency).toBe('USD')
    expect(row.exchangeRateMillionths).toBe(1_000_000)
    expect(row.functionalRemainingCents).toBe(500_000)
  })
})

describe('drawing a euro retainer', () => {
  async function euroRetainerAndWork() {
    const { customer, project } = await euroClient()

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: customer.id,
      receivedOn: '2026-04-01',
      amountCents: 1_000_000,
      currency: 'EUR',
      financialAccountId: fixture.financialAccountId,
    })

    // Two hours at €150 — €300 of work, billed in June at the later rate.
    const entry = await logTime(fixture.ctx, {
      projectId: project.id,
      workedOn: '2026-06-06',
      minutes: 120,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])

    return { customer, project, retainer }
  }

  /** The operation itself, blocked since Phase 35. */
  it('can be done at all', async () => {
    const { customer, project, retainer } = await euroRetainerAndWork()

    const result = await billWork(fixture.ctx, {
      projectId: project.id,
      customerId: customer.id,
      issueDate: '2026-06-30',
      currency: 'EUR',
      applyRetainerId: retainer.id,
    })

    expect(result.retainerAppliedCents).toBe(30_000)
  })

  /**
   * The substance. €300 drawn from a retainer carried at 1.0835 releases
   * $325.05 of liability; the invoice was raised at 1.10 so it gives up
   * $330.00 of receivable. The $4.95 between them is a realised loss — the
   * business took the money in when the euro was worth less.
   */
  it('realises the movement between the two rates', async () => {
    const { customer, project, retainer } = await euroRetainerAndWork()

    await billWork(fixture.ctx, {
      projectId: project.id,
      customerId: customer.id,
      issueDate: '2026-06-30',
      currency: 'EUR',
      applyRetainerId: retainer.id,
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.isBalanced).toBe(true)

    // The liability is down by what it was carried at, not by the face amount.
    const held = balances.rows.find((row: { number: string; balanceCents: number }) => row.number === '2550')?.balanceCents ?? 0
    expect(held).toBe(convert(1_000_000, ARRIVED) - convert(30_000, ARRIVED))

    // And the difference is named, on the exchange account: released minus
    // relieved, which is `settleHeld`'s `realisedCents`.
    //
    // Negative because 7100 is *other income* and so credit-normal, and this is
    // a loss — the firm took the euro in when it was worth less than the work
    // it later paid for, so the money it holds covers $4.95 less than the
    // invoice demands.
    const fx = balances.rows.find((row: { number: string; balanceCents: number }) => row.number === '7100')?.balanceCents ?? 0
    expect(fx).toBe(convert(30_000, ARRIVED) - convert(30_000, BILLED))
    expect(fx).toBe(-495)
  })

  it('takes both halves of the retainer down together', async () => {
    const { customer, project, retainer } = await euroRetainerAndWork()

    await billWork(fixture.ctx, {
      projectId: project.id,
      customerId: customer.id,
      issueDate: '2026-06-30',
      currency: 'EUR',
      applyRetainerId: retainer.id,
    })

    const [row] = await db.select().from(retainers).where(eq(retainers.id, retainer.id))
    expect(row.remainingCents).toBe(970_000)
    expect(row.functionalRemainingCents).toBe(
      convert(1_000_000, ARRIVED) - convert(30_000, ARRIVED),
    )
  })

  /**
   * Phase 62's rule, a third time: money held in one currency has not
   * discharged a demand in another.
   */
  it('is refused against an invoice in another currency', async () => {
    const { customer, project, retainer } = await euroRetainerAndWork()

    await expect(
      billWork(fixture.ctx, {
        projectId: project.id,
        customerId: customer.id,
        issueDate: '2026-06-30',
        // Billed in dollars against a euro retainer.
        applyRetainerId: retainer.id,
      }),
    ).rejects.toThrow(/is in EUR and .* is in USD/)
  })

  /** A domestic draw realises nothing and posts two lines, as it always did. */
  it('leaves a domestic draw byte for byte what it was', async () => {
    const { customer, project } = await euroClient()

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: customer.id,
      receivedOn: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })

    const entry = await logTime(fixture.ctx, {
      projectId: project.id,
      workedOn: '2026-06-06',
      minutes: 120,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])

    await billWork(fixture.ctx, {
      projectId: project.id,
      customerId: customer.id,
      issueDate: '2026-06-30',
      applyRetainerId: retainer.id,
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.rows.find((row: { number: string; balanceCents: number }) => row.number === '2550')?.balanceCents).toBe(470_000)
    // Nothing to realise, so nothing posted to the exchange account.
    expect(balances.rows.find((row: { number: string; balanceCents: number }) => row.number === '7100')?.balanceCents ?? 0).toBe(0)
    expect(balances.isBalanced).toBe(true)
  })
})
