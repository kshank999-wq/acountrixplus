import { beforeEach, describe, expect, it } from 'vitest'
import {
  addUserWithRole,
  createCompanyFixture,
  insertTransaction,
  type Fixture,
} from './helpers'
import { historyFor, recentActivity } from '@/modules/audit'
import { tell } from '@/modules/audit/story'
import {
  createBill,
  createVendor,
  updateVendor,
  voidDocument,
} from '@/modules/receivables/service'
import { categorize, transactionHistory } from '@/modules/bookkeeping/transactions'
import { PermissionError } from '@/modules/permissions'

/**
 * The record nobody could read (Phase 71).
 *
 * `historyFor` and `recentActivity` have existed since Phase 3 and every
 * caller of either was in this directory. Neither checked a permission —
 * `audit:view` was declared for exactly this, granted to two roles, reasoned
 * about in other modules' comments as though it were the gate, and never once
 * enforced.
 */

let fixture: Fixture
let expenseId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Readable Books' })
  expenseId = (await fixture.account('6000')).id
})

async function aVendor() {
  return createVendor(fixture.ctx, { name: 'Harborview Supply', email: 'accounts@harborview.test' })
}

async function aBill(vendorId: string) {
  return createBill(fixture.ctx, {
    vendorId,
    issueDate: '2026-04-01',
    dueDate: '2026-05-01',
    lines: [{ chartAccountId: expenseId, description: 'Parts', unitPriceCents: 100_000 }],
  })
}

describe('who may read a history', () => {
  /**
   * The rule this phase settled: you may read the history of a record you may
   * read. A bookkeeper who can open a bank transaction can see what was done
   * to it without holding the permission that opens the whole company's log.
   */
  it('lets somebody who may see the record see what happened to it', async () => {
    const vendor = await aVendor()
    await updateVendor(fixture.ctx, vendor.id, { email: 'payments@harborview.test' })

    const history = await historyFor(fixture.ctx, 'vendor', vendor.id)
    expect(history.length).toBeGreaterThan(0)
  })

  it('refuses somebody whose role does not open that record at all', async () => {
    const vendor = await aVendor()
    await updateVendor(fixture.ctx, vendor.id, { email: 'payments@harborview.test' })

    // Sales can work the pipeline and has no accounting permission.
    const sales = await addUserWithRole(fixture, 'sales')

    await expect(historyFor(sales, 'vendor', vendor.id)).rejects.toBeInstanceOf(PermissionError)
  })

  /**
   * An entity type nobody has classified falls to `audit:view` rather than to
   * everybody. A new record type appearing in the log should be readable by
   * those who may read everything, not by anybody who happens to be signed in.
   */
  it('falls back to the strict permission for an entity type nobody has placed', async () => {
    const sales = await addUserWithRole(fixture, 'sales')

    await expect(historyFor(sales, 'something_new', fixture.companyId)).rejects.toBeInstanceOf(
      PermissionError,
    )
  })

  it('gates the whole-company feed on the permission declared for it', async () => {
    const sales = await addUserWithRole(fixture, 'sales')

    await expect(recentActivity(sales)).rejects.toBeInstanceOf(PermissionError)
    await expect(recentActivity(fixture.ctx)).resolves.toBeInstanceOf(Array)
  })
})

describe('what a history hands back', () => {
  it('does not hand a screen the address somebody signed in from', async () => {
    const vendor = await aVendor()

    const [row] = await historyFor(fixture.ctx, 'vendor', vendor.id)

    expect(row).toBeDefined()
    expect(row).not.toHaveProperty('ipAddress')
    expect(row).not.toHaveProperty('userAgent')
    // The company is the scope of the query, not something a caller needs told.
    expect(row).not.toHaveProperty('companyId')
    // `userId` does stay: it is the durable identity behind a display name,
    // and a feed that filtered on the name would conflate two colleagues who
    // share one.
    expect(row.userId).toBe(fixture.userId)
  })

  it('is bounded, so one busy record cannot return everything', async () => {
    const vendor = await aVendor()

    for (let i = 0; i < 6; i++) {
      await updateVendor(fixture.ctx, vendor.id, { phone: `020 7000 000${i}` })
    }

    expect(await historyFor(fixture.ctx, 'vendor', vendor.id, 3)).toHaveLength(3)
  })

  it('is newest first', async () => {
    const vendor = await aVendor()
    await updateVendor(fixture.ctx, vendor.id, { phone: '020 7000 0001' })

    const history = await historyFor(fixture.ctx, 'vendor', vendor.id)

    expect(history[0].action).toBe('vendor.update')
    expect(history.at(-1)?.action).toBe('vendor.create')
  })
})

describe('the facts that were written and never read', () => {
  /**
   * Phase 45 records a supplier's before and after on every edit because
   * changing a supplier's details is the commonest invoice-fraud vector a
   * small business meets. Until now nothing could display either half.
   */
  it('shows what a supplier detail changed from and to', async () => {
    const vendor = await aVendor()
    await updateVendor(fixture.ctx, vendor.id, { email: 'payments@harborv1ew.test' })

    const [latest] = await historyFor(fixture.ctx, 'vendor', vendor.id)
    const told = tell(latest)

    expect(told.changes).toEqual([
      {
        key: 'email',
        label: 'Email',
        kind: 'plain',
        from: 'accounts@harborview.test',
        to: 'payments@harborv1ew.test',
      },
    ])
  })

  /**
   * Phase 70 made five corrections insist on a reason *"so somebody reading
   * the books later does not have to guess"* — and there was no screen for
   * somebody reading the books later. This is that reader.
   */
  it('shows the reason a document was cancelled', async () => {
    const vendor = await aVendor()
    const bill = await aBill(vendor.id)

    await voidDocument(fixture.ctx, 'bill', bill.id, 'Duplicate of BILL-1001')

    const told = (await historyFor(fixture.ctx, 'bill', bill.id)).map(tell)
    const cancellation = told.find((line) => line.action === 'bill.void')

    expect(cancellation?.reason).toBe('Duplicate of BILL-1001')
    // And it reads in the words Phase 70 decided, not in words invented here.
    expect(cancellation?.label).toBe('Document cancelled')
    expect(cancellation?.named).toBe(true)
  })

  it('leaves an unnamed action as its own name rather than inventing prose', () => {
    expect(tell({ action: 'vendor.update' }).named).toBe(false)
  })
})

describe('one answer to "what happened to this record"', () => {
  /**
   * There were two implementations of this query: `historyFor` in the audit
   * module and a second inside `bookkeeping/transactions`, which gated and
   * selected explicit columns while the first did neither. The careful one
   * survives as the rule; the careless one is gone.
   */
  it('answers a transaction the same way it answers anything else', async () => {
    const transaction = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'Fuel',
    })
    await categorize(fixture.ctx, transaction.id, expenseId)

    const throughBookkeeping = await transactionHistory(fixture.ctx, transaction.id)
    const throughAudit = await historyFor(fixture.ctx, 'bank_transaction', transaction.id)

    expect(throughBookkeeping.length).toBeGreaterThan(0)
    expect(throughBookkeeping.map((row) => row.id)).toEqual(throughAudit.map((row) => row.id))
  })

  /**
   * And a bookkeeper, who may open the transaction but does not hold
   * `audit:view`, still gets its history — which is the whole reason the
   * permission is decided per entity type rather than fixed at the strict one.
   */
  it('lets a bookkeeper read a transaction they may open', async () => {
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')
    const transaction = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'Fuel',
    })
    await categorize(fixture.ctx, transaction.id, expenseId)

    await expect(
      historyFor(bookkeeper, 'bank_transaction', transaction.id),
    ).resolves.toHaveLength(1)
  })
})
