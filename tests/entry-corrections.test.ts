import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { journalEntries } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  closePeriod,
  entryForSource,
  postManualEntry,
  voidEntry,
} from '@/modules/ledger/journal'
import {
  correctEntry,
  correctableEntries,
  entryDetail,
} from '@/modules/ledger/corrections-service'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { arAging } from '@/modules/ledger/reports'

/**
 * Correcting a journal entry (Phase 51).
 *
 * Two claims under test:
 *
 *  1. **An entry that is the ledger half of a document cannot be touched from
 *     the ledger.** Voiding the entry behind an invoice would leave the invoice
 *     claiming money Accounts Receivable no longer carries — the one
 *     disagreement Phase 31 went to the trouble of proving never happens.
 *  2. **An entry in a closed period is reversed, not voided**, so a correction
 *     to a period somebody has already reported on is visible rather than
 *     silent.
 */

let fixture: Fixture
let cashId: string
let equityId: string
let expenseId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Corrections Co' })
  cashId = (await fixture.account('1000')).id
  equityId = (await fixture.account('3000')).id
  expenseId = (await fixture.account('6350')).id
})

async function anEntry(entryDate = '2026-08-15', cents = 250_00) {
  return postManualEntry(fixture.ctx, {
    entryDate,
    memo: 'Coded to the wrong account',
    lines: [
      { chartAccountId: expenseId, debitCents: cents },
      { chartAccountId: cashId, creditCents: cents },
    ],
  })
}

const balanceOf = async (number: string) => {
  const account = await accountByNumber(fixture.companyId, number)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

describe('reading an entry', () => {
  /**
   * `entryWithLines` has existed since Phase 2 with no caller anywhere in
   * `src/app`, so the journal showed a number, a date, a memo and a status and
   * no money at all. An accountant could not read their own ledger.
   */
  it('shows what it actually says', async () => {
    const entry = await anEntry()
    const detail = await entryDetail(fixture.ctx, entry.id)

    expect(detail).not.toBeNull()
    expect(detail!.lines).toHaveLength(2)

    const debit = detail!.lines.find((line) => line.debitCents > 0)!
    expect(debit.accountNumber).toBe('6350')
    expect(debit.debitCents).toBe(250_00)

    const credit = detail!.lines.find((line) => line.creditCents > 0)!
    expect(credit.accountNumber).toBe('1000')
    expect(credit.creditCents).toBe(250_00)
  })

  it('is only ever an entry on these books', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const theirCash = (await other.account('1000')).id
    const theirEquity = (await other.account('3000')).id
    const theirs = await postManualEntry(other.ctx, {
      entryDate: '2026-08-15',
      lines: [
        { chartAccountId: theirCash, debitCents: 1_000 },
        { chartAccountId: theirEquity, creditCents: 1_000 },
      ],
    })

    expect(await entryDetail(fixture.ctx, theirs.id)).toBeNull()
  })
})

describe('an entry that belongs to a document', () => {
  /**
   * The substance of the phase. `voidEntry` checked a permission and an open
   * period and nothing else, so this would have succeeded — leaving the
   * invoice claiming $1,200 that Accounts Receivable no longer carried.
   *
   * It never bit only because the server action that called it had no caller
   * on any screen.
   */
  it('cannot be voided from the ledger', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const revenue = await fixture.account('4000')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-15',
      lines: [{ chartAccountId: revenue.id, description: 'Survey', unitPriceCents: 1_200_00 }],
    })

    const entry = await entryForSource(fixture.ctx, 'invoice', invoice.id)
    expect(entry).not.toBeNull()

    await expect(voidEntry(fixture.ctx, entry!.id)).rejects.toThrow(/ledger half of a document/)
    await expect(
      correctEntry(fixture.ctx, { entryId: entry!.id, method: 'void' }),
    ).rejects.toThrow(/ledger half of a document/)

    // And the books still agree, which is the thing the refusal protects.
    const aging = await arAging(fixture.ctx, { asOfDate: '2026-08-28' })
    expect(await balanceOf('1100')).toBe(aging.totals.totalCents)
    expect(aging.totals.totalCents).toBe(1_200_00)
  })

  /** Reversing it is refused for the same reason: the document is the record. */
  it('cannot be reversed from the ledger either', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const revenue = await fixture.account('4000')
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-15',
      lines: [{ chartAccountId: revenue.id, description: 'Survey', unitPriceCents: 500_00 }],
    })

    const entry = await entryForSource(fixture.ctx, 'invoice', invoice.id)

    await expect(
      correctEntry(fixture.ctx, { entryId: entry!.id, method: 'reverse' }),
    ).rejects.toThrow(/ledger half of a document/)
  })

  /**
   * The internal path is untouched. A document voiding **its own** entry, in
   * the same transaction as the document changes, is how both halves stay
   * together — and that is `voidJournalEntry`, not this.
   */
  it('still goes void when the document itself is voided', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const revenue = await fixture.account('4000')
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-15',
      lines: [{ chartAccountId: revenue.id, description: 'Survey', unitPriceCents: 900_00 }],
    })

    const before = await entryForSource(fixture.ctx, 'invoice', invoice.id)

    const { voidDocument } = await import('@/modules/receivables/service')
    await voidDocument(fixture.ctx, 'invoice', invoice.id)

    // Read by id rather than through `entryForSource`, which only ever returns
    // a *posted* entry — a voided one no longer answers "what is the ledger
    // half of this invoice", which is exactly right and is why the assertion
    // has to go round it.
    const [after] = await db.select().from(journalEntries).where(eq(journalEntries.id, before!.id))

    expect(after.status).toBe('void')
    expect(await balanceOf('1100')).toBe(0)
  })
})

describe('a hand-posted entry in an open period', () => {
  it('is voided, and stays on the record', async () => {
    const entry = await anEntry()

    const result = await correctEntry(fixture.ctx, { entryId: entry.id, method: 'void' })
    expect(result.method).toBe('void')

    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry.id))
    expect(row.status).toBe('void')
    expect(await balanceOf('6350')).toBe(0)
  })

  /**
   * Reversing is allowed here too. An open period is not proof nobody has
   * reported on it — an accountant may have given last month's numbers to the
   * bank on a Tuesday.
   */
  it('may be reversed instead, if that is what somebody wants', async () => {
    const entry = await anEntry()

    const result = await correctEntry(fixture.ctx, { entryId: entry.id, method: 'reverse' })

    expect(result.method).toBe('reverse')
    expect(result.reversalNumber).toBeGreaterThan(entry.entryNumber)

    // Both entries stand. The net is nil, which is what makes it a correction
    // rather than a deletion.
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry.id))
    expect(row.status).toBe('posted')
    expect(await balanceOf('6350')).toBe(0)
  })

  it('cannot be corrected twice', async () => {
    const entry = await anEntry()
    await correctEntry(fixture.ctx, { entryId: entry.id, method: 'reverse' })

    await expect(
      correctEntry(fixture.ctx, { entryId: entry.id, method: 'reverse' }),
    ).rejects.toThrow(/already been reversed/)
  })
})

describe('a hand-posted entry in a closed period', () => {
  /**
   * The accounting rule that makes this more than a button. Voiding an entry
   * dated inside a closed period silently changes numbers somebody has already
   * given to a bank or a tax authority.
   */
  it('is refused a void', async () => {
    const entry = await anEntry('2026-03-15')
    await closePeriod(fixture.ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })

    await expect(
      correctEntry(fixture.ctx, { entryId: entry.id, method: 'void' }),
    ).rejects.toThrow(/closed period/)

    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry.id))
    expect(row.status).toBe('posted')
  })

  /** And is reversed into a period that is still open. */
  it('is reversed into the current period instead', async () => {
    const entry = await anEntry('2026-03-15')
    await closePeriod(fixture.ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })

    const result = await correctEntry(fixture.ctx, { entryId: entry.id, method: 'reverse' })
    expect(result.method).toBe('reverse')

    const [reversal] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.reversalOfId, entry.id))

    // Not in March, which is closed. In the open period, where it can be seen.
    expect(reversal.entryDate > '2026-06-30').toBe(true)
    expect(await balanceOf('6350')).toBe(0)
  })
})

describe('the journal as a screen reads it', () => {
  it('carries a verdict for every entry', async () => {
    const mine = await anEntry()

    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const revenue = await fixture.account('4000')
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-15',
      lines: [{ chartAccountId: revenue.id, description: 'Survey', unitPriceCents: 100_00 }],
    })

    const rows = await correctableEntries(fixture.ctx, { today: '2026-08-28' })

    const hand = rows.find((row) => row.id === mine.id)!
    expect(hand.correction.ok && hand.correction.method).toBe('void')

    const derived = rows.find((row) => row.source === 'invoice')!
    expect(derived.correction.ok).toBe(false)
    expect(derived.correction.ok === false && derived.correction.why).toContain(
      'Void the invoice',
    )
  })

  /** Voided entries stay listed. That is the point of voiding rather than deleting. */
  it('keeps a voided entry in the list', async () => {
    const entry = await anEntry()
    await correctEntry(fixture.ctx, { entryId: entry.id, method: 'void' })

    const rows = await correctableEntries(fixture.ctx, { today: '2026-08-28' })
    const row = rows.find((r) => r.id === entry.id)!

    expect(row.status).toBe('void')
    expect(row.correction.ok).toBe(false)
  })

  it('names the reversal against the entry it corrected', async () => {
    const entry = await anEntry()
    const result = await correctEntry(fixture.ctx, { entryId: entry.id, method: 'reverse' })

    const rows = await correctableEntries(fixture.ctx, { today: '2026-08-28' })
    const row = rows.find((r) => r.id === entry.id)!

    expect(row.reversedBy).toBe(result.reversalNumber)
  })
})
