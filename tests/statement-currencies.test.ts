import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { putRate } from '@/modules/fx/service'
import { buildStatement } from '@/modules/receivables/statements'
import { chaseCandidates } from '@/modules/receivables/chase-run'
import { chaseVerdict, DEFAULT_CHASE_POLICY } from '@/modules/receivables/chasing'

/**
 * The statement that told the customer a made-up number (Phase 61).
 *
 * `openInvoices` selected `invoices.balance_cents` — the amount the customer
 * was invoiced in *their* currency — and the statement added those together.
 * A customer invoiced €4,000 and $1,200 was told they owed **$5,200.00**, a
 * figure in no currency at all. The same file said in a comment that every
 * figure on the statement was already the home-currency one.
 *
 * It is the worst place in the system for that to be true: Phase 42 links the
 * customer to it, Phase 55 emails it, and Phase 57 sends it monthly.
 */

let fixture: Fixture
let revenueId: string
let bankId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Statements Co' })
  revenueId = (await fixture.account('4000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: 1_080_000,
    source: 'manual',
  })
})

async function aCustomer(name: string, email = 'ap@customer.test') {
  return createCustomer(fixture.ctx, { name, email })
}

async function anInvoice(customerId: string, cents: number, currency?: string) {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    currency,
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
  })
}

describe('a customer invoiced in two currencies', () => {
  async function mixedStatement() {
    const customer = await aCustomer('Bremen Handel GmbH')
    await anInvoice(customer.id, 400_000, 'EUR')
    await anInvoice(customer.id, 120_000)

    return buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })
  }

  /** The substance of the phase. */
  it('states a balance per currency rather than inventing a total', async () => {
    const statement = await mixedStatement()

    expect(statement.currencyBalances.map((row) => row.currency)).toEqual(['EUR', 'USD'])
    expect(statement.currencyBalances[0].balanceCents).toBe(400_000)
    expect(statement.currencyBalances[1].balanceCents).toBe(120_000)
  })

  /**
   * The number the old code printed was 520,000 — €4,000 and $1,200 added as
   * though a euro were a dollar. The comparable total is €4,000 at 1.08 plus
   * $1,200, which is $5,520.
   */
  it('makes the closing balance a conversion rather than a sum of unlike things', async () => {
    const statement = await mixedStatement()

    expect(statement.closingBalanceCents).toBe(552_000)
    expect(statement.closingBalanceCents).not.toBe(520_000)
  })

  it('ages in the company’s currency too', async () => {
    const statement = await mixedStatement()

    const total = Object.values(statement.aging).reduce((sum, cents) => sum + cents, 0)
    expect(total).toBe(552_000)
  })

  it('keeps each line in the currency it was invoiced in', async () => {
    const statement = await mixedStatement()

    const euro = statement.lines.find((line) => line.currency === 'EUR')!
    expect(euro.amountCents).toBe(400_000)
    expect(euro.functionalBalanceCents).toBe(432_000)
  })

  /**
   * Phase 54's sentence covers the home-currency balance alone, because held
   * credit is only knowable in the company's own currency. Saying nothing
   * about the euro balance would leave somebody reading "nothing is due" over
   * a €4,000 invoice listed right above it.
   */
  it('says the foreign balance is outstanding separately', async () => {
    const statement = await mixedStatement()

    expect(statement.foreignNote).toContain('€4,000.00')
    expect(statement.foreignNote).toContain('outstanding separately')
  })
})

describe('an ordinary single-currency customer', () => {
  it('reads exactly as it always did', async () => {
    const customer = await aCustomer('Harborview Development')
    await anInvoice(customer.id, 120_000)
    await anInvoice(customer.id, 50_000)

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })

    expect(statement.currencyBalances).toHaveLength(1)
    expect(statement.currencyBalances[0].currency).toBe('USD')
    expect(statement.closingBalanceCents).toBe(170_000)
    expect(statement.foreignNote).toBeNull()
  })

  /** Phase 54 still nets held credit off, unchanged, for the ordinary case. */
  it('still nets off what the business is holding', async () => {
    const customer = await aCustomer('Harborview Development')
    const invoice = await anInvoice(customer.id, 100_000)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-07-10',
      amountCents: 150_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })

    expect(statement.heldCreditCents).toBe(50_000)
    expect(statement.dueCents).toBe(0)
  })

  /**
   * A credit we hold is in our money, and it has not discharged a euro
   * invoice. Netting it would be this phase's own defect one level up.
   */
  it('does not set a held credit against a foreign invoice', async () => {
    const customer = await aCustomer('Bremen Handel GmbH')
    const domestic = await anInvoice(customer.id, 100_000)
    await anInvoice(customer.id, 400_000, 'EUR')

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-07-10',
      amountCents: 150_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: domestic.id, amountCents: 100_000 }],
    })

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })

    // Nothing is owed in dollars any more, so nothing is due there...
    expect(statement.dueCents).toBe(0)
    // ...and the euro invoice is still outstanding and still says so.
    expect(statement.foreignNote).toContain('€4,000.00')
  })
})

describe('chasing on what an invoice is worth', () => {
  const policy = { ...DEFAULT_CHASE_POLICY, enabled: true, minimumBalanceCents: 50_000 }

  /**
   * The floor is set in the company's currency — somebody typing "don't chase
   * under $500" means dollars — so the comparison has to happen there. A €450
   * invoice is $486 at 1.08 and stays under it; comparing 45,000 against
   * 50,000 said the same thing for the wrong reason, and would have said the
   * opposite at a different rate.
   */
  /**
   * Sent, because Phase 43 checks that first: you cannot remind somebody of a
   * document they never received, and that rule would decide these cases
   * before the floor ever got a look at them.
   */
  async function aSentEuroCandidate(cents: number) {
    const customer = await aCustomer('Bremen Handel GmbH')
    await anInvoice(customer.id, cents, 'EUR')

    const [candidate] = await chaseCandidates(fixture.ctx.companyId)
    return { ...candidate, sentAt: '2026-06-02', sendCount: 1 }
  }

  it('spares a foreign invoice worth less than the floor', async () => {
    const candidate = await aSentEuroCandidate(45_000)
    const verdict = chaseVerdict({ invoice: candidate, policy, asOf: '2026-08-01' })

    expect(candidate.balanceCents).toBe(45_000)
    expect(candidate.functionalBalanceCents).toBe(48_600)
    expect(verdict.chase).toBe(false)
    if (!verdict.chase) expect(verdict.reason).toBe('too_small')
  })

  /** And the case the old comparison got wrong in the other direction. */
  it('chases a foreign invoice worth more than the floor', async () => {
    // €470 is $507.60 — over a $500 floor, while 47,000 < 50,000 is not.
    const candidate = await aSentEuroCandidate(47_000)
    const verdict = chaseVerdict({ invoice: candidate, policy, asOf: '2026-08-01' })

    expect(candidate.functionalBalanceCents).toBe(50_760)
    if (!verdict.chase) expect(verdict.reason).not.toBe('too_small')
  })
})
