import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, serviceItems } from '@/db/schema'
import {
  createServiceItem,
  deactivateServiceItem,
  listServiceItems,
  setServiceItemActive,
} from '@/modules/studio/service'
import { receiveStock, stockOnHand, reconcileInventory } from '@/modules/inventory/service'
import { setModuleEnabled } from '@/modules/industry/modules'
import { OPT_IN_CANDIDATES, createCompanyFixture, type Fixture } from './helpers'

/**
 * A retirement with no way back (Phase 206, spec §15).
 *
 * ## What the nomination asked, and what measuring answered
 *
 * ADR 0205 nominated `listServiceItems`' `activeOnly` — the last of this
 * module's three list functions with the **unsafe default**, where a caller
 * who forgets the flag offers retired items. The question it posed was *which
 * screens are offering retired items today*.
 *
 * **None.** All three screens that offer items pass the flag, and the Studio
 * deliberately does not because it is the library. The trap is real and the
 * live defect was not there.
 *
 * That ADR also gave a reason for declining to flip the default — *"a
 * behaviour change in five screens dressed as a tidy-up"* — and both halves
 * were wrong: four callers, and no behaviour change, since every offer-site
 * already passed the flag. So this phase flips it, and that is a tidy-up the
 * measurement licensed rather than one it excused.
 *
 * It also feared that retiring an inventoried item with stock would hide a
 * balance the subledger carries. It does not: `stockOnHand` filters on
 * `isInventoried` and **not** on `isActive`.
 *
 * ## The defect that was actually there
 *
 * `deactivateServiceItem` has existed since Phase 4 and set `isActive` to
 * **false only**. Nothing anywhere set it true, so an item retired by mistake
 * — or a service a business started offering again — was gone from every
 * picker for ever. It wrote no audit event either, which made it the only one
 * of the Studio's four libraries whose retirement left no trace.
 *
 * That is the **mirror** of what Phases 202–205 closed. Those were six columns
 * with a reader and no writer. This is a column with a writer in one
 * direction, which no census asks about and which looks identical to a working
 * control until somebody wants to undo it.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Ridgeline Works' })
})

async function item(name = 'Site survey') {
  return createServiceItem(fixture.ctx, { name, unitPriceCents: 25_000 })
}

describe('the direction that did not exist', () => {
  it('puts a retired item back, which nothing could do', async () => {
    /**
     * The whole phase in one assertion. `deactivateServiceItem` could take an
     * item out of every picker and there was no path to `isActive = true`
     * anywhere in the repository — a delete wearing a flag.
     */
    const survey = await item()

    await setServiceItemActive(fixture.ctx, { itemId: survey.id, isActive: false })
    expect(await listServiceItems(fixture.ctx)).toEqual([])

    await setServiceItemActive(fixture.ctx, { itemId: survey.id, isActive: true })
    expect((await listServiceItems(fixture.ctx)).map((row) => row.id)).toEqual([survey.id])
  })

  it('records both directions, which it had never recorded either of', async () => {
    /**
     * The only one of the Studio's four libraries whose retirement left no
     * trace: brand kits, clauses and team members all record both. Separate
     * from `item.update`, which is what `saveItemAction` writes when somebody
     * changes a price — *why is this not on the picker* and *why did this
     * price change* are different questions.
     */
    const survey = await item()

    await setServiceItemActive(fixture.ctx, { itemId: survey.id, isActive: false })
    await setServiceItemActive(fixture.ctx, { itemId: survey.id, isActive: true })

    const actions = (
      await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.companyId, fixture.companyId))
    ).map((row) => row.action)

    expect(actions).toContain('service_item.retire')
    expect(actions).toContain('service_item.restore')
  })

  it('keeps the old name working, through the new one rather than beside it', async () => {
    /*
      Four phases of callers use `deactivateServiceItem`, so the name stays —
      as a call through to `setServiceItemActive` rather than a second
      implementation. Two answers to one question is the defect, and the one
      thing the old signature cannot express is putting an item back.
    */
    const survey = await item()

    await deactivateServiceItem(fixture.ctx, survey.id)

    const [row] = await db
      .select({ isActive: serviceItems.isActive })
      .from(serviceItems)
      .where(eq(serviceItems.id, survey.id))
    expect(row.isActive).toBe(false)

    // And it audits now, which the old implementation did not.
    const events = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.companyId, fixture.companyId))
    expect(events.map((event) => event.action)).toContain('service_item.retire')
  })

  it('is scoped, so one company cannot retire another’s catalogue', async () => {
    const survey = await item()
    const other = await createCompanyFixture({ name: 'Elsewhere Ltd' })

    await expect(
      setServiceItemActive(other.ctx, { itemId: survey.id, isActive: false }),
    ).rejects.toThrow(/not in this catalogue/)
  })
})

describe('the default nobody had measured', () => {
  it('offers live items to a caller that passes nothing', async () => {
    /**
     * The flip. `activeOnly` opt-in meant forgetting the flag offered retired
     * items; `includeRetired` opt-out means forgetting it is safe. The three
     * list functions in this module agree now.
     */
    const survey = await item('Site survey')
    const old = await item('Site survey (2019 rate)')

    await setServiceItemActive(fixture.ctx, { itemId: old.id, isActive: false })

    expect((await listServiceItems(fixture.ctx)).map((row) => row.id)).toEqual([survey.id])
    expect(await listServiceItems(fixture.ctx, { includeRetired: true })).toHaveLength(2)
  })

  it('changed no behaviour, which is why it was allowed to change at all', () => {
    /**
     * The measurement that licensed the tidy-up, asserted so the claim is not
     * just an ADR sentence. All three screens that **offer** items passed
     * `activeOnly: true` already, so flipping the sense leaves each of them
     * asking for exactly what it asked for before — and the Studio, the one
     * screen that manages them, now says so explicitly.
     *
     * ADR 0205 declined this on the grounds that it was a behaviour change in
     * five screens. Four callers, and no behaviour change.
     */
    const offers = [
      'src/app/crm/proposals/page.tsx',
      'src/app/accounting/invoices/page.tsx',
      'src/app/manufacturing/page.tsx',
    ]

    for (const page of offers) {
      const source = readFileSync(page, 'utf8')
      expect(source, page).toContain('listServiceItems(actor)')
      expect(source, page).not.toMatch(/listServiceItems\([^)]*includeRetired/)
    }

    const studio = readFileSync('src/app/studio/page.tsx', 'utf8')
    expect(studio).toContain('listServiceItems(actor, { includeRetired: true })')

    // Narrowed to this function's own call sites. A blanket search for the old
    // flag name caught `listFinancialAccounts(actor, { activeOnly: true })` on
    // the invoices page — which is **a different function with the same unsafe
    // default**, and finding it that way is how this phase learned that
    // `listServiceItems` was one of seven rather than the last one.
    for (const page of [...offers, 'src/app/studio/page.tsx']) {
      const source = readFileSync(page, 'utf8')
      expect(source, page).not.toMatch(/listServiceItems\([^)]*activeOnly/)
    }
  })
})

describe('retiring an item that still holds stock', () => {
  beforeEach(async () => {
    await setModuleEnabled(fixture.ctx, 'inventory', true)
  })

  it('leaves the stock, its value and the reconciliation exactly as they were', async () => {
    /**
     * The nomination's other fear, measured and false. `stockOnHand` filters
     * on `isInventoried` and not on `isActive`, so a retired item keeps its
     * lots and its line — which is the right answer rather than a lucky one:
     * stopping something being **sold** is a different act from writing off
     * what is left of it, which is Phase 203's distinction and it already
     * holds here.
     *
     * Asserted through `reconcileInventory`, because the failure this guards
     * against is the subledger figure dropping while the Inventory account
     * does not — a check that cries wolf on books somebody deliberately
     * changed, which is exactly what Phase 203 refused to build.
     */
    const [stocked] = await db
      .insert(serviceItems)
      .values({ companyId: fixture.companyId, name: 'Oak plank', isInventoried: true })
      .returning()

    // 2050 Goods Received Not Invoiced, because `creditableByReceipt` refuses
    // Accounts Payable — a balance there with no document is money nobody can
    // pay. Phase 48's rule, and the refusal said so by name.
    const payable = await fixture.account('2050')
    await receiveStock(fixture.ctx, {
      itemId: stocked.id,
      quantityMilli: 10_000,
      unitCostCents: 500,
      receivedOn: '2026-03-01',
      creditAccountId: payable.id,
    })

    const before = await stockOnHand(fixture.ctx)
    const beforeCheck = await reconcileInventory(fixture.ctx)
    expect(beforeCheck.agrees).toBe(true)
    expect(before).toHaveLength(1)

    await setServiceItemActive(fixture.ctx, { itemId: stocked.id, isActive: false })

    // Still counted, still valued, still agreeing.
    expect(await stockOnHand(fixture.ctx)).toEqual(before)
    const afterCheck = await reconcileInventory(fixture.ctx)
    expect(afterCheck.agrees).toBe(true)
    expect(afterCheck.subledgerCents).toBe(beforeCheck.subledgerCents)
  })

  it('is out of the pickers while its stock is still on the books', async () => {
    // The two halves together, which is the point: a retired item is not
    // offered and is not forgotten.
    const [stocked] = await db
      .insert(serviceItems)
      .values({ companyId: fixture.companyId, name: 'Oak plank', isInventoried: true })
      .returning()

    // 2050 Goods Received Not Invoiced, because `creditableByReceipt` refuses
    // Accounts Payable — a balance there with no document is money nobody can
    // pay. Phase 48's rule, and the refusal said so by name.
    const payable = await fixture.account('2050')
    await receiveStock(fixture.ctx, {
      itemId: stocked.id,
      quantityMilli: 10_000,
      unitCostCents: 500,
      receivedOn: '2026-03-01',
      creditAccountId: payable.id,
    })
    await setServiceItemActive(fixture.ctx, { itemId: stocked.id, isActive: false })

    expect(await listServiceItems(fixture.ctx)).toEqual([])
    expect((await stockOnHand(fixture.ctx)).map((row) => row.itemId)).toEqual([stocked.id])
  })
})

describe('the four pickers that were offering retired accounts', () => {
  /**
   * The finding the nomination's question should have had.
   *
   * ADR 0205 asked which screens offer retired **items** and the answer was
   * none. Asking it of the right denominator found that `listServiceItems` is
   * one of **seven** list functions with the `activeOnly` opt-in default — and
   * that `listAccounts`, the chart of accounts, had **four callers feeding a
   * `<select>` with no flag at all**:
   *
   * | | |
   * | --- | --- |
   * | `drawers` | *"Where it lands"* on a till pay-out |
   * | `takings` | the account a day's takings are categorised into |
   * | `budgets` | the account a plan is set against |
   * | `billing` | the account a recurring invoice line earns into |
   *
   * A retired chart account offered for a **posting** is worse than a retired
   * service item offered on a line: `account.retire`'s own docstring says
   * retiring *"takes it out of every picker"*, and it did not. That sentence
   * had been wrong since Phase 118.
   *
   * Found by a blanket search in the test above catching the wrong function,
   * which is the sort of accident worth recording rather than tidying away.
   */
  it('filter the chart of accounts now', () => {
    for (const page of [
      'src/app/drawers/page.tsx',
      'src/app/takings/page.tsx',
      'src/app/accounting/budgets/page.tsx',
      'src/app/accounting/billing/page.tsx',
    ]) {
      const source = readFileSync(page, 'utf8')
      expect(source, page).toContain('listAccounts(actor, { activeOnly: true })')
      expect(source, page).not.toMatch(/listAccounts\(actor\)/)
    }
  })

  it('leaves the two that need every account alone', () => {
    /**
     * Not a filter everywhere. `dimensions` builds a **name lookup** so a
     * posting on a retired account still reads with its name, and the §19
     * portability export must carry the whole chart — filtering either would
     * be the opposite defect, and the difference is offering against
     * displaying.
     */
    const dimensions = readFileSync('src/app/accounting/dimensions/page.tsx', 'utf8')
    expect(dimensions).toMatch(/listAccounts\(actor\)/)
    expect(dimensions).toContain('accountNames')

    const exporter = readFileSync('src/modules/exporter/package.ts', 'utf8')
    expect(exporter).toContain('listAccounts(ctx)')
  })

  it('is one of seven functions with the same unsafe default', () => {
    /**
     * Declared with the count rather than claimed closed, because each
     * remaining one's flagless callers need reading to tell an offer from a
     * list. `listServiceItems` is flipped and the chart's four pickers are
     * fixed; the rest is nominated.
     *
     * Measured from the source so the number cannot drift from the sentence —
     * Phase 179's rule applied to a claim about the shape of the code rather
     * than to a figure in prose.
     *
     * **Six when this phase measured it, five since Phase 207** flipped
     * `banking/accounts.ts`. The file list is deliberately the same one
     * `tests/a-name-is-not-a-function.test.ts` checks, so the two phases'
     * assertions count the same class and cannot drift apart independently —
     * which is what Phases 204 and 205 did with the switch register, and what
     * sent the full run red twice.
     */
    const withOptIn = OPT_IN_CANDIDATES.filter((file) =>
      /activeOnly\?: boolean/.test(readFileSync(file, 'utf8')),
    )

    expect(withOptIn).toHaveLength(5)

    // And `listServiceItems` is no longer among them, which is the one this
    // phase was nominated to fix.
    const studio = readFileSync('src/modules/studio/service.ts', 'utf8')
    expect(studio).not.toMatch(/activeOnly\?: boolean/)
    expect(studio).toContain('includeRetired?: boolean')
  })
})

describe('the mirror the censuses do not ask about', () => {
  it('is a writer in one direction, which looks like a working control', () => {
    /**
     * Phases 201–205 measured columns with a **reader and no writer**, and
     * Phase 203 measured and declined the mirror of that — columns written and
     * never read — because `.select()` with no projection makes the scan
     * unsound in that direction.
     *
     * This is a third shape neither asks about: a column with a writer that
     * only ever moves it one way. No census reports it, because the column is
     * read *and* written; it looks identical to a working control until
     * somebody wants to undo it. `deactivateServiceItem` was that for 202
     * phases, and it was found by reading the one list function the previous
     * phase had left alone.
     *
     * Asserted on the source, because the claim is that the one-directional
     * write is gone rather than that some value is now reachable.
     */
    const service = readFileSync('src/modules/studio/service.ts', 'utf8')

    // The old body set one value and took no argument for the other.
    expect(service).not.toContain(".set({ isActive: false })\n    .where(and(eq(serviceItems.id")
    // The new one takes the direction from the caller.
    expect(service).toContain('.set({ isActive: input.isActive })')
    expect(service).toContain('export async function setServiceItemActive')
  })
})
