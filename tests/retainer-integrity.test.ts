import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, invoices, retainerApplications, retainers } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { INTEGRITY_CHECKS, checkByKey } from '@/modules/integrity/register'
import { runIntegrityChecks } from '@/modules/integrity/service'
import { retainerPosition } from '@/modules/timebilling/billing'
import { createCustomer } from '@/modules/receivables/service'
import { setModuleEnabled } from '@/modules/industry/modules'

/**
 * Client money, against what the books say we owe on it (Phase 105).
 *
 * The register checked gift cards against 2590, tenant deposits against 2580,
 * overpayments against 2520 and practitioner earnings against 2320, and had
 * nothing for retainers — a client's money, taken before the work is done.
 *
 * The claim that matters is the pair at the bottom: a retainer whose ledger half
 * never happened is caught on a dedicated account, and caught on a shared one
 * too as long as it pushes the retainers past everything deferred.
 */

describe('the check is in the register', () => {
  it('names retainers, and says which account it compares against', () => {
    const check = checkByKey('timebilling.retainers')

    expect(check).toBeDefined()
    expect(check!.severity).toBe('fault')
    expect(check!.module).toBe('time_billing')
    // The fallback is part of what it compares, so the register says so.
    expect(check!.compares).toContain('2550')
    expect(check!.compares).toContain('2500')
  })

  it('explains itself the way the sibling checks do', () => {
    const check = checkByKey('timebilling.retainers')!
    expect(check.meaning.length).toBeGreaterThan(60)
    // Named beside the obligation it is the twin of.
    expect(check.meaning).toContain('landlord')
  })

  it('leaves every other check alone', () => {
    const keys = INTEGRITY_CHECKS.map((check) => check.key)
    expect(new Set(keys).size).toBe(keys.length)

    for (const sibling of [
      'appointments.gift_cards',
      'properties.deposits',
      'receivables.customer_credit',
    ]) {
      expect(keys).toContain(sibling)
    }
  })
})

describe('against the database', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Retainer Integrity Co' })
    // The check is gated on the module, correctly — a company that does not
    // take retainers should not be told about an account it does not use.
    await setModuleEnabled(fixture.ctx, 'time_billing', true)
  })

  /** Gives the company a dedicated 2550, which the standard pack does not install. */
  const installDedicated = async () => {
    await db.insert(chartAccounts).values({
      companyId: fixture.companyId,
      number: '2550',
      name: 'Client Retainers Held',
      type: 'liability',
      // The same subtype 2500 carries, which is what makes Phase 12's
      // cash-basis transformation treat a retainer correctly either way.
      subtype: 'deferred_revenue',
      isActive: true,
    })
  }

  const holdRetainer = async (cents: number, functionalCents = cents) => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harbour Chambers' })
    await db.insert(retainers).values({
      companyId: fixture.companyId,
      customerId: customer.id,
      receivedOn: '2026-01-05',
      currency: 'USD',
      amountCents: cents,
      remainingCents: cents,
      functionalRemainingCents: functionalCents,
    })
  }

  /**
   * A retainer taken and then drawn to nothing, with the application row that
   * says where the money went (Phase 112).
   *
   * Straight to the tables rather than through the service, like its sibling
   * above, so these tests stay about the position rather than about billing —
   * but *with* the dated row, because a balance that came down with nothing
   * recording the draw is not a spent retainer, it is a broken one.
   */
  const spendRetainer = async (cents: number) => {
    const customer = await createCustomer(fixture.ctx, { name: 'Spent Chambers' })
    const [invoice] = await db
      .insert(invoices)
      .values({
        companyId: fixture.companyId,
        customerId: customer.id,
        number: `INV-SPENT-${cents}`,
        issueDate: '2026-02-01',
        dueDate: '2026-03-01',
        status: 'paid',
        subtotalCents: cents,
        totalCents: cents,
        balanceCents: 0,
      })
      .returning()
    const [retainer] = await db
      .insert(retainers)
      .values({
        companyId: fixture.companyId,
        customerId: customer.id,
        receivedOn: '2026-01-06',
        currency: 'USD',
        amountCents: cents,
        remainingCents: 0,
        functionalRemainingCents: 0,
      })
      .returning()

    await db.insert(retainerApplications).values({
      companyId: fixture.companyId,
      retainerId: retainer.id,
      invoiceId: invoice.id,
      amountCents: cents,
      carriedCents: cents,
      appliedOn: '2026-02-01',
    })
  }

  it('reports the shared account when the pack installed no 2550', async () => {
    // Six of the seven companies in the development database are in this state,
    // which is why the check cannot simply demand equality.
    const position = await retainerPosition(fixture.ctx)

    expect(position.holding).toBe('shared')
    expect(position.accountNumber).toBe('2500')
  })

  it('reports the dedicated account once it exists', async () => {
    await installDedicated()
    const position = await retainerPosition(fixture.ctx)

    expect(position.holding).toBe('dedicated')
    expect(position.accountNumber).toBe('2550')
  })

  it('sums the company’s own money rather than the money that arrived', async () => {
    // A retainer carries the currency it came in (Phase 66); the ledger is in
    // the company's own. Adding the first across currencies is the sum Phase 65
    // was named for eliminating — and doing it inside a check would be worse.
    //
    // A real euro retainer rather than a dollar one with a hand-set functional
    // column (Phase 112): the position is rebuilt from the amount and the rate
    // beside it, so a row whose functional figure contradicts its own currency
    // proves nothing about the claim being made here.
    const customer = await createCustomer(fixture.ctx, { name: 'Rue Vaugirard SARL' })
    await db.insert(retainers).values({
      companyId: fixture.companyId,
      customerId: customer.id,
      receivedOn: '2026-01-05',
      currency: 'EUR',
      exchangeRateMillionths: 1_100_000,
      amountCents: 400_000,
      remainingCents: 400_000,
      functionalRemainingCents: 440_000,
    })

    const position = await retainerPosition(fixture.ctx)
    // €4,000 at 1.10 — not 400000, which is the money that arrived.
    expect(position.heldCents).toBe(440_000)
  })

  it('counts only the retainers with something left on them', async () => {
    await holdRetainer(300_000)
    // Spent through a draw, which is the only way `remaining_cents` legitimately
    // comes down — `applyRetainer` writes the application and `refundRetainer`
    // writes the refund, and there is no third path.
    await spendRetainer(100_000)

    expect((await retainerPosition(fixture.ctx)).openCount).toBe(1)
  })

  it('will not take a drawn-down retainer’s word for it (Phase 112)', async () => {
    // Before this phase the position read `functional_remaining_cents` and a
    // retainer that said it had been spent was believed, whatever the ledger
    // knew. Rebuilding from dated movements means a balance that came down
    // with nothing recording where the money went now shows as still held —
    // which is a fault, and the honest one: the subledger cannot explain
    // itself.
    const customer = await createCustomer(fixture.ctx, { name: 'Unexplained Chambers' })
    await db.insert(retainers).values({
      companyId: fixture.companyId,
      customerId: customer.id,
      receivedOn: '2026-01-06',
      currency: 'USD',
      amountCents: 100_000,
      remainingCents: 0,
      functionalRemainingCents: 0,
    })

    const position = await retainerPosition(fixture.ctx)
    expect(position.heldCents).toBe(100_000)
    expect(position.openCount).toBe(1)
  })

  it('catches a retainer whose ledger half never happened, on a dedicated account', async () => {
    await installDedicated()
    // Written straight to the table, which is what a half-committed pair looks
    // like from the outside.
    await holdRetainer(320_000)

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row: { key: string }) => row.key === 'timebilling.retainers')!

    expect(finding.agrees).toBe(false)
    expect(finding.leftCents).toBe(320_000)
    expect(finding.rightCents).toBe(0)
    expect(finding.detail).toContain('one half happened without the other')
  })

  it('catches it on a shared account too, once it exceeds everything deferred', async () => {
    await holdRetainer(320_000)

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row: { key: string }) => row.key === 'timebilling.retainers')!

    expect(finding.agrees).toBe(false)
    expect(finding.detail).toContain('should be the larger of the two')
    expect(finding.detail).toContain('A ledger half is missing')
  })

  it('says the shared check is the weaker one even when it passes', async () => {
    // Nothing held, so the check passes. The caveat still rides along: on a
    // shared account the tick means less than it looks like.
    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row: { key: string }) => row.key === 'timebilling.retainers')!

    expect(finding.agrees).toBe(true)
    expect(finding.detail).toContain('2500 Unearned Revenue')
    expect(finding.detail).toContain('Installing 2550')
  })

  it('says nothing extra when the account is the company’s own', async () => {
    await installDedicated()

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row: { key: string }) => row.key === 'timebilling.retainers')!

    expect(finding.agrees).toBe(true)
    // No caveat and no complaint: the strong check ran and passed.
    expect(finding.detail ?? '').toBe('')
  })
})
