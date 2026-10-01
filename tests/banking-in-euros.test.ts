import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, depositMovements, journalLines, taxRemittances } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer } from '@/modules/receivables/service'
import { createProperty, createUnit, createLease } from '@/modules/properties/service'
import { receiveDeposit, refundDeposit, depositPosition } from '@/modules/properties/deposits'
import { createEmployee, createPayrollRun, resolvePayrollAccounts } from '@/modules/payroll/service'
import { liabilityPositions, recordRemittance } from '@/modules/payroll/remittance'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { FX_ACCOUNTS, putRate } from '@/modules/fx/service'
import { setModuleEnabled } from '@/modules/industry/modules'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { Refusal } from '@/modules/errors'

/**
 * Banking in euros, which three paths could not do at all (Phase 153).
 *
 * ## The acceptance test ADR 0136 said could not be written yet
 *
 * `PENDING_WIRING` carried `mayPostToBank` with `acceptance: null` for seventeen
 * phases, and the `null` was the honest answer: a test written against a column
 * that does not exist is fiction rather than a definition of done. Phase 153
 * added the columns, so this is the test.
 *
 * Three of the four paths are wired here. `receivePledge` is not — it needs a
 * row rather than a column, which `PENDING_WIRING` now says in those words, and
 * `tests/bank-money.test.ts` holds it to that.
 *
 * ## What the three do differently
 *
 * `receiveDeposit` **creates** the liability it posts against, so the credit is
 * exactly the converted debit and there is no difference to realise.
 * `refundDeposit` and `recordRemittance` **relieve** a balance the books already
 * carry, so the bank takes the rate on the day and the gap is a realised gain or
 * loss. Both mistakes balance, which is why each is asserted rather than left to
 * the entry footing.
 */

let fixture: Fixture
let leaseId: string
let euroAccountId: string

/** 1.10 in March, 1.20 in September — a deposit held across a rate movement. */
const MARCH = 1_100_000
const SEPTEMBER = 1_200_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Rheinhaus Immobilien', industry: 'real_estate' })
  await setModuleEnabled(fixture.ctx, 'properties', true)

  for (const [rateDate, rateMillionths] of [
    ['2026-03-01', MARCH],
    ['2026-09-01', SEPTEMBER],
  ] as const) {
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate,
      rateMillionths,
      source: 'manual',
    })
  }

  const euro = await createFinancialAccount(fixture.ctx, {
    name: 'Frankfurt Current',
    kind: 'checking',
    currency: 'EUR',
  })
  euroAccountId = euro.id

  const property = await createProperty(fixture.ctx, {
    code: 'RHE',
    name: 'Rheinstraße 14',
    city: 'Frankfurt',
  })
  const unit = await createUnit(fixture.ctx, {
    propertyId: property.id,
    code: '2B',
    marketRentCents: 120_000,
  })
  const tenant = await createCustomer(fixture.ctx, { name: 'Lena Fischer' })
  const lease = await createLease(fixture.ctx, {
    unitId: unit.id,
    customerId: tenant.id,
    startsOn: '2026-01-01',
    endsOn: null,
    rentCents: 120_000,
    depositRequiredCents: 240_000,
    activate: true,
  })
  leaseId = lease.id
})

/** What one account was debited and credited across every posted entry. */
async function movement(number: string): Promise<{ debit: number; credit: number }> {
  const rows = await db
    .select({ debit: journalLines.debitCents, credit: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, number)))

  return {
    debit: rows.reduce((total, row) => total + row.debit, 0),
    credit: rows.reduce((total, row) => total + row.credit, 0),
  }
}

describe('a deposit taken into a euro account', () => {
  it('is held at all, which it could not be before', async () => {
    // The capability, not the figure. Every one of these three refused outright
    // until Phase 153 and the refusal was honest: nothing recorded what currency
    // the money was in.
    const row = await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 200_000,
      currency: 'EUR',
      occurredOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    expect(row.id).toBeTruthy()
  })

  it('credits the liability what the bank was debited, and nothing else', async () => {
    // `created-here`. €2,000 at 1.10 is $2,200, and that is both lines: the
    // tenancy was not owed anything a moment ago, so there is no earlier figure
    // for today's rate to differ from.
    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 200_000,
      currency: 'EUR',
      occurredOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    const liability = await movement(INDUSTRY_ACCOUNTS.tenantSecurityDeposits)
    expect(liability.credit).toBe(220_000)

    // And no realised gain. A difference here would be conjured from one
    // conversion, and the entry would still foot.
    const fx = await movement(FX_ACCOUNTS.gainOrLoss)
    expect(fx.debit + fx.credit).toBe(0)
  })

  it('writes down what the tenant handed over and the rate it was posted at', async () => {
    // Phase 129's rule: the posting records the rate it used, so a movement
    // reconciled months later is reconciled against the rate it was posted at
    // rather than whatever the rate table says by then.
    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 200_000,
      currency: 'EUR',
      occurredOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    const [row] = await db
      .select()
      .from(depositMovements)
      .where(eq(depositMovements.leaseId, leaseId))

    expect(row.bankFaceCents).toBe(200_000)
    expect(row.currency).toBe('EUR')
    expect(row.exchangeRateMillionths).toBe(MARCH)
    // The liability, in the books' own money, which is the figure that moved.
    expect(row.amountCents).toBe(220_000)
  })
})

describe('the same deposit returned six months later', () => {
  it('realises the movement rather than leaving the bank short', async () => {
    // `already-carried`, and the figure that makes the two cases different.
    // €2,000 came in at 1.10 and is held at $2,200. Giving it back in September
    // at 1.20 costs the bank $2,400. The liability still comes off at $2,200,
    // and the $200 is a realised loss — not an understatement of the bank.
    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 200_000,
      currency: 'EUR',
      occurredOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    const position = await depositPosition(fixture.ctx, leaseId)
    expect(position.heldCents).toBe(220_000)

    await refundDeposit(fixture.ctx, {
      leaseId,
      amountCents: 220_000,
      bank: { faceCents: 200_000, currency: 'EUR' },
      occurredOn: '2026-09-01',
      financialAccountId: euroAccountId,
    })

    // The liability is square: $2,200 in, $2,200 out.
    const liability = await movement(INDUSTRY_ACCOUNTS.tenantSecurityDeposits)
    expect(liability.credit).toBe(220_000)
    expect(liability.debit).toBe(220_000)
    expect((await depositPosition(fixture.ctx, leaseId)).heldCents).toBe(0)

    // The bank gave up $2,400 of worth across the two movements: debited
    // $2,200 in March, credited $2,400 in September.
    const euroGl = await db
      .select({ number: chartAccounts.number })
      .from(chartAccounts)
      .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.name, 'Frankfurt Current')))
      .limit(1)
    const bank = await movement(euroGl[0].number)
    expect(bank.debit).toBe(220_000)
    expect(bank.credit).toBe(240_000)

    // And the $200 between them is named. Debit less credit is negative, so it
    // is a loss and the exchange account is debited — `Settlement`'s convention,
    // which this does not restate.
    const fx = await movement(FX_ACCOUNTS.gainOrLoss)
    expect(fx.debit).toBe(20_000)
    expect(fx.credit).toBe(0)
  })

  it('still refuses to give back more than is held', async () => {
    // The guard that was there before, measured on the figure that moves: the
    // liability, in the books' own money. Nothing about the currency loosened it.
    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 200_000,
      currency: 'EUR',
      occurredOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    await expect(
      refundDeposit(fixture.ctx, {
        leaseId,
        amountCents: 300_000,
        bank: { faceCents: 250_000, currency: 'EUR' },
        occurredOn: '2026-09-01',
        financialAccountId: euroAccountId,
      }),
    ).rejects.toThrow(/cannot be refunded/)
  })
})

describe('a payroll liability remitted from a euro account', () => {
  async function withPayroll() {
    await resolvePayrollAccounts(fixture.ctx)
    const employee = await createEmployee(fixture.ctx, {
      name: 'Jonas Weber',
      reference: 'E-001',
      payBasis: 'salary',
      baseRateCents: 6_000_000,
      taxIdLast4: '4471',
    })

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [
        {
          employeeId: employee.id,
          lines: [
            { kind: 'earning' as const, label: 'Salary', amountCents: 500_000 },
            {
              kind: 'employee_tax' as const,
              label: 'Income tax withheld',
              amountCents: 75_000,
              agency: 'Finanzamt',
            },
          ],
        },
      ],
    })

    const positions = await liabilityPositions(fixture.ctx, { asOfDate: '2026-09-01' })
    return positions.find((row) => row.balanceCents > 0)!
  }

  it('relieves the liability at its own figure and names the difference', async () => {
    const position = await withPayroll()

    // The liability is a ledger balance in the company's own money, accrued when
    // the payroll ran. Paying it with euros worth more than it costs the
    // difference, and the difference has somewhere to go.
    const faceCents = Math.round((position.balanceCents / SEPTEMBER) * 1_000_000)

    await recordRemittance(fixture.ctx, {
      kind: 'payroll',
      agency: 'Finanzamt',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      paidOn: '2026-09-01',
      amountCents: position.balanceCents,
      bank: { faceCents, currency: 'EUR' },
      liabilityAccountId: position.accountId,
      financialAccountId: euroAccountId,
    })

    // The liability is relieved by exactly what it owed.
    const after = await liabilityPositions(fixture.ctx, { asOfDate: '2026-09-02' })
    expect(after.find((row) => row.accountId === position.accountId)?.balanceCents ?? 0).toBe(0)

    const [row] = await db.select().from(taxRemittances)
    expect(row.amountCents).toBe(position.balanceCents)
    expect(row.bankFaceCents).toBe(faceCents)
    expect(row.currency).toBe('EUR')
    expect(row.exchangeRateMillionths).toBe(SEPTEMBER)
  })

  it('posts no exchange line when the rate leaves nothing over', async () => {
    // A domestic remittance, unchanged. Every row written before Phase 153 is
    // this case, which is why the migration's backfill records no damage.
    const position = await withPayroll()

    await recordRemittance(fixture.ctx, {
      kind: 'payroll',
      agency: 'Revenue authority',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      paidOn: '2026-09-01',
      amountCents: position.balanceCents,
      liabilityAccountId: position.accountId,
      financialAccountId: fixture.financialAccountId,
    })

    const fx = await movement(FX_ACCOUNTS.gainOrLoss)
    expect(fx.debit + fx.credit).toBe(0)

    const [row] = await db.select().from(taxRemittances)
    expect(row.bankFaceCents).toBe(position.balanceCents)
    expect(row.exchangeRateMillionths).toBe(1_000_000)
  })

  it('still refuses a remittance larger than the ledger says is owed', async () => {
    const position = await withPayroll()

    await expect(
      recordRemittance(fixture.ctx, {
        kind: 'payroll',
        agency: 'Finanzamt',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        paidOn: '2026-09-01',
        amountCents: position.balanceCents + 1_000,
        bank: { faceCents: 10_000, currency: 'EUR' },
        liabilityAccountId: position.accountId,
        financialAccountId: euroAccountId,
      }),
    ).rejects.toThrow(Refusal)
  })
})

describe('what is still refused, and why that is right', () => {
  it('refuses a euro deposit into a dollar account', async () => {
    // The gate's other branch, untouched. The bank converts at its own rate on
    // the day and these books do not have that rate, so any figure posted is a
    // guess at somebody else's arithmetic.
    await expect(
      receiveDeposit(fixture.ctx, {
        leaseId,
        amountCents: 200_000,
        currency: 'EUR',
        occurredOn: '2026-03-01',
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/held in USD/)
  })

  it('refuses a dollar figure into a euro account when nothing says otherwise', async () => {
    // Omit the currency and the Phase 133 rule stands, which is what keeps every
    // path that has not been wired honest.
    await expect(
      receiveDeposit(fixture.ctx, {
        leaseId,
        amountCents: 200_000,
        occurredOn: '2026-03-01',
        financialAccountId: euroAccountId,
      }),
    ).rejects.toThrow(/held in EUR/)
  })
})
