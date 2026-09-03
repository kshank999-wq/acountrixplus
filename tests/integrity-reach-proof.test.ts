import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { INTEGRITY_CHECKS, checkByKey } from '@/modules/integrity/register'
import { setModuleEnabled } from '@/modules/industry/modules'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { receiveStock } from '@/modules/inventory/service'
import { registerAsset } from '@/modules/assets/service'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { db } from '@/db'
import { serviceItems } from '@/db/schema'

/**
 * Proving what Phase 109 only claimed (Phase 110).
 *
 * Phase 109 gave every check an `asAt` declaration and admitted the tripwire was
 * weak:
 *
 * > it asserts every check *declares* a reach with prose, not that an
 * > `any_date` one actually varies with the date.
 *
 * It also defaulted fifteen checks to `today_only` on the grounds that reaching
 * back was "not verified" — and four of those were verifiable, and wrong.
 * `properties.deposits` filters `deposit_movements.occurred_on <= asOf` for
 * every movement kind; `assets.register` filters `depreciation_entries.
 * period_end`; `pos.tips` filters `pos_days.business_date`; and
 * `funds.untagged_contributions` passes the date through to every figure it
 * reads. Declaring them today-only switched off four working checks.
 *
 * ## The tripwire
 *
 * A check whose subledger side honours the date must report **nothing** for a
 * date before the company existed — there was no stock, no deposit and no
 * invoice in 1900. One that ignores the date reports today's figure against an
 * empty ledger instead, and the difference is what this catches.
 *
 * It is a real proof only where the fixture has activity in that subledger, so
 * the fixture below builds some, and the vacuous cases are named rather than
 * counted as evidence.
 */

/** Before any company in this application existed. */
const LONG_BEFORE = '1900-01-01'

describe('an any_date check reports nothing before the books began', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Reach Proof Co' })
  })

  it('holds for the control accounts, which have activity', async () => {
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })

    const check = checkByKey('ledger.receivables')!
    const today = await check.run(fixture.ctx, '2026-09-03')
    const before = await check.run(fixture.ctx, LONG_BEFORE)

    // The invoice exists today and did not exist in 1900.
    expect(today.leftCents).toBe(100_000)
    expect(before.leftCents).toBe(0)
    expect(before.agrees).toBe(true)
  })

  it('holds for inventory, which Phase 109 repaired', async () => {
    await setModuleEnabled(fixture.ctx, 'inventory', true)
    const [widget] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        name: 'Widget',
        unit: 'each',
        isInventoried: true,
      })
      .returning()
    await receiveStock(fixture.ctx, {
      itemId: widget.id,
      quantityMilli: 10_000,
      unitCostCents: 500,
      receivedOn: '2026-03-01',
      creditAccountId: (await fixture.account('2050')).id,
    })

    const check = checkByKey('inventory.lots')!
    const today = await check.run(fixture.ctx, '2026-09-03')
    const before = await check.run(fixture.ctx, LONG_BEFORE)

    expect(today.leftCents).toBe(5_000)
    expect(before.leftCents).toBe(0)
    expect(before.agrees).toBe(true)
  })

  it('holds for the asset register, which Phase 111 repaired', async () => {
    await registerAsset(fixture.ctx, {
      name: 'Excavator',
      costCents: 5_000_000,
      lifeMonths: 48,
      acquiredDate: '2026-01-10',
      inServiceDate: '2026-01-10',
      postAcquisitionCreditAccountId: (
        await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.defaultChecking)
      )!.id,
    })

    const check = checkByKey('assets.register')!
    const today = await check.run(fixture.ctx, '2026-09-03')
    const before = await check.run(fixture.ctx, LONG_BEFORE)

    expect(today.leftCents).toBe(5_000_000)
    expect(before.leftCents).toBe(0)
    expect(before.agrees).toBe(true)
  })

  it('holds for every any_date check every company gets', async () => {
    // Only the ungated ones: a module check wants a chart this company has no
    // reason to carry, and the register skips it for that reason rather than
    // running it. Vacuous for a subledger with no activity, too — named here
    // rather than counted as evidence, since a check that ignores the date also
    // reports 0 when there is nothing to report.
    const ungated = INTEGRITY_CHECKS.filter(
      (entry) => entry.asAt.reach === 'any_date' && entry.module === null,
    )
    expect(ungated.length).toBeGreaterThan(0)

    for (const check of ungated) {
      const before = await check.run(fixture.ctx, LONG_BEFORE)
      expect(before.leftCents, check.key).toBe(0)
    }
  })
})

describe('what verifying the declarations changed', () => {
  it('promotes the three whose subledger side honours the date', () => {
    const promoted: Array<[string, string]> = [
      ['properties.deposits', 'occurred_on'],
      ['pos.tips', 'business_date'],
      ['funds.untagged_contributions', 'netAssets'],
    ]

    for (const [key, evidence] of promoted) {
      const check = checkByKey(key)!
      expect(check.asAt.reach, key).toBe('any_date')
      expect(check.asAt.because, key).toContain(evidence)
    }
  })

  it('repairs the two Phase 110 understood but did not fix', () => {
    // Phase 110 kept both `today_only` and wrote down exactly what stopped
    // them. Phase 111 acted on what it had written: neither reason survives.
    const assets = checkByKey('assets.register')!
    expect(assets.asAt.reach).toBe('any_date')
    expect(assets.asAt.because).not.toContain('no date filter')

    const wip = checkByKey('manufacturing.wip')!
    expect(wip.asAt.reach).toBe('any_date')
    expect(wip.asAt.because).not.toContain("status = 'released'")
  })

  it('leaves the ones with no dated history alone', () => {
    for (const key of [
      'appointments.gift_cards',
      'appointments.payouts',
      'payments.in_transit',
      'receivables.customer_credit',
      'inventory.goods_received',
      'fx.conversions',
      'timebilling.retainers',
    ]) {
      expect(checkByKey(key)!.asAt.reach, key).toBe('today_only')
    }
  })

  it('no longer says “not verified” of anything', () => {
    // Phase 109 left fifteen declarations reading "Not verified to reach back."
    // A claim nobody has checked is exactly what this project keeps finding at
    // the bottom of a defect, so none survive.
    for (const check of INTEGRITY_CHECKS) {
      expect(check.asAt.because, check.key).not.toContain('Not verified')
    }
  })
})
