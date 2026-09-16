import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, financialAccounts, journalEntries, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { recoverWriteOff, writeOffInvoice } from '@/modules/receivables/credits'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { putRate } from '@/modules/fx/service'
import { trialBalance } from '@/modules/ledger/balances'

/**
 * A write-off recovered at a rate it was never carried at (Phase 136 → 139).
 *
 * ## Unskipped by Phase 151, which wired it
 *
 * `recoverWriteOff` goes through `recoverHeld` now, the entry is off
 * `PENDING_WIRING`, and this is what says it worked.
 *
 * ## The defect it described, which is now repaired
 *
 * `recoverWriteOff` posts `recovery.functionalCents` to **both** lines, at the
 * write-off's own carried rate. That is right for bad debt — a later rate would
 * fold a currency movement into an expense, which is what `recoveryFunctional`
 * takes no rate parameter to prevent (Phase 116) — and wrong for the bank,
 * which receives what actually arrived on the day.
 *
 * Measured before any of this was written: €2,500 written off at 1.0835 and
 * recovered in full at 1.10 puts **$2,708.75** on a euro cash account whose
 * statement says **$2,750** — $41.25 unnamed, and `recoverWriteOff` is the only
 * path relieving a carried balance that never reaches `ensureFxAccount`.
 *
 * ## No new core is needed
 *
 * ADRs 0136, 0137 and 0138 each nominated this as though something had to be
 * built. `recoverHeld` already answers it — what arrives at the day's rate
 * against what leaves at the carried one — and `refundVendorCredit` is the
 * working precedent. It is wiring, which is why it lives on the register rather
 * than in a phase of its own.
 */

let fixture: Fixture
let revenueId: string
let euroAccountId: string
/**
 * The euro account's own ledger account.
 *
 * This test asked for `1000` until Phase 151 ran it. A foreign bank account
 * gets a chart account of its own — `1001 Frankfurt Current ••8802` — so
 * looking for the debit on the default cash account found nothing while the
 * posting was correct. An assumption written before the account existed.
 */
let euroChartAccountId: string

/** 1.0835 when it was written off; 1.10 when the money turned up. */
const CARRIED = 1_083_500
const RECOVERED = 1_100_000

const FACE = 250_000
/** €2,500 at 1.0835. */
const AT_CARRIED = 270_875
/** €2,500 at 1.10 — what actually arrived. */
const AT_DAY = 275_000
const REALISED = AT_DAY - AT_CARRIED

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Recovery Co' })
  revenueId = (await fixture.account('4000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-03-01',
    rateMillionths: CARRIED,
    source: 'manual',
  })
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-09-01',
    rateMillionths: RECOVERED,
    source: 'manual',
  })

  // The money arrives in euros, so it lands in a euro account — which this path
  // may only be told about once it has a day rate (Phase 136's `withheld:
  // 'no-day-rate'`). Wiring this entry is what unblocks that declaration too.
  const account = await createFinancialAccount(fixture.ctx, {
    name: 'Frankfurt Current',
    kind: 'checking',
    currency: 'EUR',
    mask: '8802',
  })
  euroAccountId = account.id

  const [row] = await db
    .select({ chartAccountId: financialAccounts.chartAccountId })
    .from(financialAccounts)
    .where(eq(financialAccounts.id, account.id))
  euroChartAccountId = row.chartAccountId
})

async function writtenOffEuroInvoice() {
  const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })

  const invoice = await createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: '2026-04-01',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: FACE }],
  })

  return writeOffInvoice(fixture.ctx, invoice.id, {
    writtenOffOn: '2026-03-01',
    reason: 'Customer stopped answering',
  })
}

async function linesOn(number: string) {
  const [account] = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, number)))

  return linesOnAccount(account.id)
}

async function linesOnAccount(chartAccountId: string) {
  return db
    .select({ debitCents: journalLines.debitCents, creditCents: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, fixture.companyId),
        eq(journalEntries.sourceType, 'write_off_recovery'),
        eq(journalLines.chartAccountId, chartAccountId),
      ),
    )
}

describe('recovering a euro write-off when the rate has moved', () => {
  it('banks what actually arrived, at the rate on the day', async () => {
    const writeOff = await writtenOffEuroInvoice()

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-09-01',
      amountCents: FACE,
      financialAccountId: euroAccountId,
    })

    // $2,750, not $2,708.75. What the statement will show.
    const bank = await linesOnAccount(euroChartAccountId)
    expect(bank.length).toBe(1)
    expect(bank[0].debitCents).toBe(AT_DAY)
  })

  it('backs bad debt out at the rate it was carried at', async () => {
    // The half that is already right and must stay right. Relieving the expense
    // at the day's rate would fold a currency movement into bad debt, and
    // `badDebtSummary` would report a loss that never happened.
    const writeOff = await writtenOffEuroInvoice()

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-09-01',
      amountCents: FACE,
      financialAccountId: euroAccountId,
    })

    const badDebt = await linesOn('6025')
    expect(badDebt.length).toBe(1)
    expect(badDebt[0].creditCents).toBe(AT_CARRIED)
  })

  it('names the $41.25 between them as a realised gain', async () => {
    // The euro was worth more when the money turned up than when the debt was
    // given up on, so the business recovered more than it wrote off. 7100 is
    // other income, so a gain reads positive.
    const writeOff = await writtenOffEuroInvoice()

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-09-01',
      amountCents: FACE,
      financialAccountId: euroAccountId,
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    const fx = balances.rows.find(
      (row: { number: string; balanceCents: number }) => row.number === '7100',
    )?.balanceCents

    expect(fx).toBe(REALISED)
    expect(REALISED).toBe(4_125)
  })

  it('keeps the books balanced', async () => {
    const writeOff = await writtenOffEuroInvoice()

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-09-01',
      amountCents: FACE,
      financialAccountId: euroAccountId,
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(balances.isBalanced).toBe(true)
  })
})

describe('a domestic recovery, which is every one so far', () => {
  it('posts two lines and realises nothing', async () => {
    // Why this went unnoticed: with one currency the carried rate and the day's
    // rate are both 1.0, so the two figures are the same number and there is no
    // third line to write.
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Homes' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: FACE }],
    })

    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-03-01',
      reason: 'Customer stopped answering',
    })

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-09-01',
      amountCents: FACE,
      financialAccountId: fixture.financialAccountId,
    })

    // The fixture's own account, not the euro one — same lookup, different
    // bank, because a domestic recovery lands where the company's money lives.
    const [home] = await db
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(eq(financialAccounts.id, fixture.financialAccountId))

    const bank = await linesOnAccount(home.chartAccountId)
    expect(bank[0].debitCents).toBe(FACE)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    const fx = balances.rows.find(
      (row: { number: string; balanceCents: number }) => row.number === '7100',
    )?.balanceCents
    expect(fx ?? 0).toBe(0)
  })
})
