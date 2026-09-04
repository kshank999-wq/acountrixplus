import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { financialAccounts, repairOrders } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import type { Industry, IndustryModule } from '@/modules/coa/industry'
import { setModuleEnabled } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { postManualEntry } from '@/modules/ledger/journal'
import { createCustomer } from '@/modules/receivables/service'
import { addDrawer, openShift } from '@/modules/drawer/service'
import { FALSIFIERS, falsifierFor } from '@/modules/integrity/falsifiable'
import {
  INTEGRITY_CHECKS,
  runIntegrityChecks,
  type Finding,
} from '@/modules/integrity/service'

/**
 * Every check, driven to disagree (Phase 121).
 *
 * Measured before this file existed: **7 of the 20 checks had ever been
 * asserted to report `agrees: false`. Thirteen had only ever been seen to
 * agree**, which is not the same as working. Phase 115 found
 * `receivables.customer_credit` comparing euros with dollars after eighty
 * phases of agreeing, and Phase 117 found `inventory.goods_received`'s subject
 * broken in the project's own seed. Both by accident, phases apart.
 *
 * So each check now states what would break it (`FALSIFIERS`), and this proves
 * the stated break actually breaks it: **agrees before, disagrees after.**
 */

/** What a check needs before it will run, and how to break it. */
type Scenario = {
  industry?: Industry
  modules?: IndustryModule[]
  /** Anything the check needs before it can agree — or before its account exists. */
  prepare?: (fixture: Fixture) => Promise<void>
  /** For the checks whose falsifier is not a journal entry against one account. */
  falsify?: (fixture: Fixture) => Promise<void>
}

/** A hand-written entry straight at a control account: the act ADR 0033 says nothing legitimately does. */
async function journalAgainst(fixture: Fixture, number: string, cents = 25_000) {
  const target = await accountByNumber(fixture.companyId, number)
  const other = await accountByNumber(fixture.companyId, '4000')
  if (!target) throw new Error(`the falsifier names ${number}, which is not on this chart`)

  await postManualEntry(fixture.ctx, {
    entryDate: '2026-04-02',
    memo: `Somebody journalled straight at ${number}`,
    lines: [
      { chartAccountId: target.id, debitCents: cents, creditCents: 0 },
      { chartAccountId: other!.id, debitCents: 0, creditCents: cents },
    ],
  })
}

const SCENARIOS: Record<string, Scenario> = {
  'ledger.receivables': {},
  'ledger.payables': {},
  'banking.shared_ledger_accounts': {
    // The check counts how the chart is wired, so the falsifier writes the row
    // a migration would: a second account on a ledger account already in use.
    falsify: async (fixture) => {
      const [existing] = await db
        .select()
        .from(financialAccounts)
        .where(eq(financialAccounts.id, fixture.financialAccountId))
        .limit(1)

      await db.insert(financialAccounts).values({
        companyId: fixture.companyId,
        chartAccountId: existing.chartAccountId,
        name: 'Second Current Account',
        mask: '9911',
        kind: 'checking',
        providerAccountId: 'test-checking-002',
      })
    },
  },
  'banking.cash_tie_out': {},
  'payments.in_transit': {},
  'payables.duplicate_bills': {
    // The one check with nothing on its right-hand side, so the falsifier is
    // the suspicion itself.
    falsify: async (fixture) => {
      const { createVendor, createBill } = await import('@/modules/receivables/service')
      const vendor = await createVendor(fixture.ctx, { name: 'Ridge Supplies' })
      const expense = await accountByNumber(fixture.companyId, '6000')
      // A repeated *reference* is refused outright and cannot be overridden —
      // "there is nothing for a person to know that the supplier's own
      // numbering does not already say". So the state this check hunts is the
      // other kind: two references that look like the same invoice. The second
      // is a warning, which a person may proceed past, and that is exactly the
      // one worth a second pair of eyes later.
      // Neither carries a supplier reference: two referenced bills are
      // deliberately left alone, because the supplier has already said they
      // are two documents.
      for (const number of ['B-1', 'B-2']) {
        await createBill(fixture.ctx, {
          vendorId: vendor.id,
          number,
          acknowledgeDuplicate: number !== 'B-1',
          issueDate: '2026-04-01',
          dueDate: '2026-05-01',
          lines: [
            { chartAccountId: expense!.id, description: 'Timber', unitPriceCents: 12_000 },
          ],
        })
      }
    },
  },
  'parties.shared_addresses': {
    falsify: async (fixture) => {
      // "Address" here is the email address: the check selects id, name and
      // email and clashes on those. Nothing in it reads a postal address,
      // which the first run of this file discovered by trying one.
      for (const name of ['Ash Court Ltd', 'Ash Court Trading']) {
        await createCustomer(fixture.ctx, { name, email: 'accounts@ashcourt.test' })
      }
    },
  },
  'assets.register': {},
  'appointments.gift_cards': { industry: 'personal_care', modules: ['appointments'] },
  'appointments.payouts': { industry: 'personal_care', modules: ['appointments'] },
  'cash_drawer.open_tills': {
    industry: 'retail',
    modules: ['cash_drawer'],
    // 1060 is in no industry pack — it is installed on first use, so the
    // falsifier has nothing to post against until a till has been opened.
    prepare: async (fixture) => {
      const drawer = await addDrawer(fixture.ctx, { name: 'Front counter' })
      await openShift(fixture.ctx, { drawerId: drawer.id, floatCents: 10_000 })
    },
  },
  'funds.untagged_contributions': {
    industry: 'nonprofit',
    modules: ['funds'],
    // Two subledgers rather than a subledger and a ledger: revenue against the
    // contributions that name a fund.
    falsify: async (fixture) => {
      // 4500 Contribution Revenue: the check counts lines on the two
      // contribution accounts that carry no Fund dimension, not revenue at
      // large.
      const revenue = await accountByNumber(fixture.companyId, '4500')
      const bank = await accountByNumber(fixture.companyId, '1000')
      await postManualEntry(fixture.ctx, {
        entryDate: '2026-04-02',
        memo: 'A gift nobody tagged to a fund',
        lines: [
          { chartAccountId: bank!.id, debitCents: 50_000, creditCents: 0 },
          { chartAccountId: revenue!.id, debitCents: 0, creditCents: 50_000 },
        ],
      })
    },
  },
  'inventory.lots': { industry: 'retail', modules: ['inventory'] },
  'inventory.goods_received': { industry: 'retail', modules: ['inventory'] },
  'receivables.customer_credit': {},
  'manufacturing.wip': { industry: 'manufacturing', modules: ['manufacturing'] },
  'pos.tips': { industry: 'restaurant', modules: ['pos_import'] },
  'properties.deposits': { industry: 'real_estate', modules: ['properties'] },
  'timebilling.retainers': { industry: 'professional_services', modules: ['time_billing'] },
  'vehicles.authorisations': {
    industry: 'automotive',
    modules: ['vehicles'],
    // A column against the rows that should explain it, so the falsifier moves
    // the column.
    falsify: async (fixture) => {
      const { addVehicle, openRepairOrder } = await import('@/modules/vehicles/service')
      const customer = await createCustomer(fixture.ctx, { name: 'Priya Raman' })
      const vehicle = await addVehicle(fixture.ctx, {
        customerId: customer.id,
        registration: 'YK21 ZRT',
        make: 'Vauxhall',
        model: 'Combo',
      })
      const order = await openRepairOrder(fixture.ctx, {
        vehicleId: vehicle.id,
        complaint: 'Brakes',
        openedOn: '2026-04-01',
      })

      // Straight at the column, with no authorisation row to explain it.
      await db
        .update(repairOrders)
        .set({ authorisedCents: 90_000 })
        .where(eq(repairOrders.id, order.id))
    },
  },
}

/**
 * The five the first run could not drive to disagree, and what each one turned
 * out to be. Phase 121 proved fifteen; this is the honest remainder, and it is
 * meant to shrink rather than to sit here.
 */
const NOT_YET_PROVEN: Record<string, string> = {
  'banking.shared_ledger_accounts':
    'Cannot be falsified at all, and that is the finding. ' +
    '`financial_accounts_chart_account_unique` refuses the second row — from the application ' +
    'and from a migration alike — so the state this check looks for is one the database will ' +
    'not hold. Either the constraint is newer than the check and quietly made it moot, in which ' +
    'case it should be retired the way Phase 116 retired fx.conversions, or the check is for ' +
    'books that predate the constraint, in which case it should say so. Deciding which is a ' +
    'phase of its own, and this entry is what stops the question being forgotten.',
}

function findingFor(findings: Finding[], key: string): Finding {
  const found = findings.find((row) => row.key === key)
  if (!found) throw new Error(`No finding for ${key} — the check did not run`)
  return found
}

describe('every check declares how it can fail', () => {
  it('covers the register exactly, in both directions', () => {
    const registered = INTEGRITY_CHECKS.map((check) => check.key).sort()
    const declared = FALSIFIERS.map((row) => row.key).sort()

    // A check with no falsifier is a green light nobody has wired up; a
    // falsifier with no check is a rule outliving what it described.
    expect(declared).toEqual(registered)
  })

  it('has a scenario for every declared falsifier', () => {
    const missing = FALSIFIERS.filter((row) => !SCENARIOS[row.key]).map((row) => row.key)
    expect(missing).toEqual([])
  })

  it('argues for each falsifier rather than just naming an account', () => {
    for (const row of FALSIFIERS) {
      expect(row.how.length, row.key).toBeGreaterThan(30)
      expect(row.because.length, row.key).toBeGreaterThan(90)
    }
  })

  it('names an account only where the check reconciles against one', () => {
    // The three that compare a count, a column against its rows, or two
    // subledgers carry their falsifier entirely in prose.
    const withoutAccount = FALSIFIERS.filter((row) => row.account === null).map((row) => row.key)
    expect(withoutAccount.sort()).toEqual(
      [
        'banking.shared_ledger_accounts',
        'funds.untagged_contributions',
        'parties.shared_addresses',
        'payables.duplicate_bills',
        'vehicles.authorisations',
      ].sort(),
    )
  })

  it('refuses a check nobody declared a falsifier for', () => {
    expect(() => falsifierFor('ledger.something_new')).toThrow(/No falsifier is declared/)
  })
})

describe('the declared falsifier actually falsifies', () => {
  const proven = FALSIFIERS.filter((row) => !NOT_YET_PROVEN[row.key])

  it('leaves a shrinking list of checks nobody has driven to disagree', () => {
    // Fifteen of twenty on the first run; nineteen once the four scenario
    // errors that run exposed were corrected. Every entry here says what
    // stopped it, because "unproven" with no reason is how a gap becomes
    // permanent.
    expect(Object.keys(NOT_YET_PROVEN).length).toBeLessThanOrEqual(1)
    for (const [key, why] of Object.entries(NOT_YET_PROVEN)) {
      expect(FALSIFIERS.map((row) => row.key), key).toContain(key)
      expect(why.length, key).toBeGreaterThan(120)
    }
  })

  for (const falsifier of proven) {
    it(`${falsifier.key} agrees, then disagrees once broken`, async () => {
      const scenario = SCENARIOS[falsifier.key]
      const fixture = await createCompanyFixture({
        name: 'Falsify Co',
        industry: scenario.industry ?? 'general',
      })
      for (const module of scenario.modules ?? []) {
        await setModuleEnabled(fixture.ctx, module, true)
      }
      await scenario.prepare?.(fixture)

      const before = findingFor(
        (await runIntegrityChecks(fixture.ctx, { persist: false })).findings,
        falsifier.key,
      )
      expect(before.agrees, `${falsifier.key} should start out agreeing`).toBe(true)

      if (scenario.falsify) await scenario.falsify(fixture)
      else await journalAgainst(fixture, falsifier.account!)

      const after = findingFor(
        (await runIntegrityChecks(fixture.ctx, { persist: false })).findings,
        falsifier.key,
      )
      expect(after.agrees, `${falsifier.key}: ${falsifier.how}`).toBe(false)
    })
  }
})
