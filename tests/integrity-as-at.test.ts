import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { runIntegrityChecks } from '@/modules/integrity/service'
import { INTEGRITY_CHECKS, checkByKey } from '@/modules/integrity/register'
import { reconcileInventory, receiveStock } from '@/modules/inventory/service'
import { setModuleEnabled } from '@/modules/industry/modules'
import { db } from '@/db'
import { serviceItems } from '@/db/schema'

/**
 * The register asked about a date that is not today (Phase 109).
 *
 * Every check takes an `asOf`. Most walk their ledger side back to it and read
 * their subledger side as it stands now — Phase 108 fixed the two control
 * accounts and did not reach the rest. Measured across three dates on the
 * development books, `inventory.lots` was the one that flipped:
 *
 * ```
 * 2026-09-03: agrees  2855920/2855920
 * 2026-05-31: DIFFERS 2855920/1668600
 * 2026-03-31: DIFFERS 2855920/0
 * ```
 *
 * It is a **fault**, so March reported $28,559.20 of broken books on books that
 * were correct.
 */

describe('the register skips what it cannot answer', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Reach Co' })
  })

  it('runs every applicable check when asked about today', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const run = await runIntegrityChecks(fixture.ctx, { asOf: today })

    expect(run.outOfReach).toEqual([])
    expect(run.findings.length).toBeGreaterThan(0)
  })

  it('leaves out the today-only checks when asked about the past', async () => {
    const run = await runIntegrityChecks(fixture.ctx, { asOf: '2026-03-31' })

    const todayOnly = INTEGRITY_CHECKS.filter((check) => check.asAt.reach === 'today_only')
    expect(run.outOfReach.length).toBeGreaterThan(0)
    for (const key of run.outOfReach) {
      expect(todayOnly.map((check) => check.key), key).toContain(key)
    }
  })

  it('still runs the ones that reach back', async () => {
    const run = await runIntegrityChecks(fixture.ctx, { asOf: '2026-03-31' })
    const ran = run.findings.map((finding: { key: string }) => finding.key)

    // Phase 108 built these two to restore both sides, so a past date is a
    // question they can answer.
    expect(ran).toContain('ledger.receivables')
    expect(ran).toContain('ledger.payables')
  })

  it('never reports an out-of-reach check as a finding', async () => {
    // The whole point: skipped rather than answered wrongly.
    const run = await runIntegrityChecks(fixture.ctx, { asOf: '2026-03-31' })
    const ran = new Set(run.findings.map((finding: { key: string }) => finding.key))

    for (const key of run.outOfReach) expect(ran.has(key)).toBe(false)
  })

  it('counts a date-gated skip apart from a module-gated one', async () => {
    // A module switched off is a check that does not apply; this is one that
    // applies but cannot answer. Reporting them as one number would leave
    // somebody thinking a check they rely on had been turned off.
    const run = await runIntegrityChecks(fixture.ctx, { asOf: '2026-03-31' })

    for (const key of run.outOfReach) expect(run.skipped).not.toContain(key)
  })
})

describe('inventory, restored to the date', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Stock History Co' })
    await setModuleEnabled(fixture.ctx, 'inventory', true)
  })

  const item = async () => {
    const [row] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        name: 'Widget',
        unit: 'each',
        isInventoried: true,
      })
      .returning()
    return row
  }

  it('values the lots at what they were worth then, not now', async () => {
    const widget = await item()
    const grni = await fixture.account('2050')

    await receiveStock(fixture.ctx, {
      itemId: widget.id,
      quantityMilli: 10_000,
      unitCostCents: 500,
      receivedOn: '2026-03-01',
      creditAccountId: grni.id,
    })
    await receiveStock(fixture.ctx, {
      itemId: widget.id,
      quantityMilli: 10_000,
      unitCostCents: 500,
      receivedOn: '2026-06-01',
      creditAccountId: grni.id,
    })

    // Before this phase the March figure was today's 10000, against a ledger
    // walked back to 5000 -- a fault on correct books.
    const march = await reconcileInventory(fixture.ctx, { asOfDate: '2026-03-31' })
    const today = await reconcileInventory(fixture.ctx, { asOfDate: '2026-09-03' })

    expect(march.subledgerCents).toBe(5_000)
    expect(march.agrees).toBe(true)
    expect(today.subledgerCents).toBe(10_000)
    expect(today.agrees).toBe(true)
  })

  it('shows nothing before the first receipt', async () => {
    const widget = await item()
    const grni = await fixture.account('2050')
    await receiveStock(fixture.ctx, {
      itemId: widget.id,
      quantityMilli: 10_000,
      unitCostCents: 500,
      receivedOn: '2026-03-01',
      creditAccountId: grni.id,
    })

    const before = await reconcileInventory(fixture.ctx, { asOfDate: '2026-02-01' })

    expect(before.subledgerCents).toBe(0)
    expect(before.agrees).toBe(true)
  })

  it('reaches any date, and says what makes that possible', () => {
    const check = checkByKey('inventory.lots')!

    expect(check.asAt.reach).toBe('any_date')
    expect(check.asAt.because).toContain('stock_movements')
    // The detail that makes it a sum rather than a case analysis.
    expect(check.asAt.because).toContain('signed')
  })

  it('answers the same for today with or without a date', async () => {
    // The nightly run passes today; nothing about it changes.
    const widget = await item()
    const grni = await fixture.account('2050')
    await receiveStock(fixture.ctx, {
      itemId: widget.id,
      quantityMilli: 4_000,
      unitCostCents: 250,
      receivedOn: '2026-03-01',
      creditAccountId: grni.id,
    })

    const undated = await reconcileInventory(fixture.ctx)
    const today = await reconcileInventory(fixture.ctx, { asOfDate: '2026-09-03' })

    expect(undated.subledgerCents).toBe(today.subledgerCents)
    expect(undated.agrees).toBe(true)
  })
})
