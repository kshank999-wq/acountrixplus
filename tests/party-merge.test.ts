import { beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
} from '@/modules/receivables/service'
import { listCustomerSummaries, mergeParties } from '@/modules/parties/service'
import {
  describeMerge,
  EXCLUSIVE_REFERENCES,
  mergeCheck,
  PARTY_REFERENCES,
} from '@/modules/parties/merge'
import { correction, mustSayWhy } from '@/modules/corrections/vocabulary'

/**
 * Putting two records of one business together (Phase 96).
 *
 * The test that matters most is the tripwire at the bottom. Everything else
 * here proves the merge does what it says; that one proves it will still be
 * doing it after somebody adds a table nobody remembered to tell it about.
 */

const active = { standing: 'trading' as const, isActive: true }

describe('what may be merged', () => {
  it('refuses a record into itself', () => {
    const one = { id: 'a', name: 'A', ...active }
    expect(mergeCheck({ side: 'customer', winner: one, loser: one })).toEqual({
      ok: false,
      why: 'A customer cannot be merged into itself. Pick two records.',
    })
  })

  it('refuses to move everything onto an archived record', () => {
    const verdict = mergeCheck({
      side: 'customer',
      winner: { id: 'a', name: 'Old Ltd', standing: 'settled', isActive: false },
      loser: { id: 'b', name: 'New Ltd', ...active },
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('Old Ltd is archived')
    // Names the way out rather than only the problem.
    expect(verdict.ok === false && verdict.why).toContain('merge the other way round')
  })

  it('refuses a loser that is already archived, because nothing is on it', () => {
    const verdict = mergeCheck({
      side: 'vendor',
      winner: { id: 'a', name: 'A', ...active },
      loser: { id: 'b', name: 'Gone Ltd', standing: 'settled', isActive: false },
    })

    expect(verdict.ok === false && verdict.why).toContain('Gone Ltd is already archived')
  })

  it('refuses when both hold a row only one may have', () => {
    // Silently dropping one would lose insurance expiry and licence numbers
    // nobody chose to lose.
    const verdict = mergeCheck({
      side: 'vendor',
      winner: { id: 'a', name: 'Twinned', ...active },
      loser: { id: 'b', name: 'Twinned Co', ...active },
      collisions: ['subcontractors'],
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('subcontractors')
    expect(verdict.ok === false && verdict.why).toContain('only one is allowed per supplier')
  })

  it('allows two live records of one side', () => {
    expect(
      mergeCheck({
        side: 'customer',
        winner: { id: 'a', name: 'A', ...active },
        loser: { id: 'b', name: 'B', ...active },
      }),
    ).toEqual({ ok: true })
  })
})

describe('what it says it will do', () => {
  it('counts what moves, so an irreversible act shows its work', () => {
    expect(
      describeMerge({
        side: 'customer',
        winnerName: 'Cascade Joinery',
        loserName: 'Cascade Joinery Ltd',
        tally: [
          { table: 'invoices', rows: 12 },
          { table: 'payments', rows: 3 },
          { table: 'credit_notes', rows: 0 },
        ],
      }),
    ).toBe(
      '15 records (12 invoices, 3 payments) will move to Cascade Joinery, and ' +
        'Cascade Joinery Ltd will be archived. This cannot be undone.',
    )
  })

  it('says so plainly when there is nothing to move', () => {
    const line = describeMerge({
      side: 'customer',
      winnerName: 'A',
      loserName: 'B',
      tally: [{ table: 'invoices', rows: 0 }],
    })

    expect(line).toContain('B has nothing on it')
    expect(line).toContain('cannot be undone')
  })
})

describe('the reason', () => {
  it('is required, because nothing here can take a merge back', () => {
    // A merge moves no money and sends no letter, so Phase 70's rule as
    // written said `internal` — and internal means nobody is asked why.
    expect(correction('party.merge').reach).toBe('cannot_be_undone')
    expect(mustSayWhy('party.merge')).toBe(true)
  })
})

describe('against the database', () => {
  let fixture: Fixture
  let revenueId: string
  let expenseId: string

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Merge Co' })
    revenueId = (await fixture.account('4000')).id
    expenseId = (await fixture.account('6000')).id
  })

  const anInvoice = (customerId: string, cents: number) =>
    createInvoice(fixture.ctx, {
      customerId,
      issueDate: '2026-02-01',
      dueDate: '2026-03-03',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
    })

  it('moves every document onto the surviving record', async () => {
    const winner = await createCustomer(fixture.ctx, { name: 'Cascade Joinery' })
    const loser = await createCustomer(fixture.ctx, { name: 'Cascade Joinery Ltd' })

    await anInvoice(winner.id, 100_000)
    await anInvoice(loser.id, 40_000)
    await anInvoice(loser.id, 60_000)

    const result = await mergeParties(fixture.ctx, {
      side: 'customer',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'Same firm, entered twice when the yard was renamed.',
    })

    expect(result.moved).toEqual([{ table: 'invoices', rows: 2 }])

    const summaries = await listCustomerSummaries(fixture.ctx)
    const survived = summaries.find((row) => row.id === winner.id)!

    expect(survived.documentCount).toBe(3)
    expect(survived.balanceCents).toBe(200_000)
    expect(summaries.find((row) => row.id === loser.id)?.isActive).toBe(false)
  })

  it('leaves the losing record pointing at the one that absorbed it', async () => {
    // Archived, not deleted: a bookmark, an export or somebody's memory of the
    // old name still lands somewhere that explains itself.
    const winner = await createCustomer(fixture.ctx, { name: 'Keep' })
    const loser = await createCustomer(fixture.ctx, { name: 'Go' })
    await anInvoice(loser.id, 1000)

    await mergeParties(fixture.ctx, {
      side: 'customer',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'One business.',
    })

    const [row] = await db.execute(
      sql`select merged_into_id::text as into, is_active from customers where id = ${loser.id}`,
    )

    expect((row as { into: string }).into).toBe(winner.id)
    expect((row as { is_active: boolean }).is_active).toBe(false)
  })

  it('records the merge on both records, not just the one that went', async () => {
    const winner = await createCustomer(fixture.ctx, { name: 'Keep' })
    const loser = await createCustomer(fixture.ctx, { name: 'Go' })

    await mergeParties(fixture.ctx, {
      side: 'customer',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'Same business, two spellings.',
    })

    const rows = await db.execute(
      sql`select entity_id::text as id, after from audit_events
          where action = 'party.merge' and company_id = ${fixture.ctx.companyId}`,
    )

    expect(rows).toHaveLength(2)
    const ids = (rows as unknown as Array<{ id: string }>).map((r) => r.id).sort()
    expect(ids).toEqual([winner.id, loser.id].sort())

    // The surviving record's history has to explain where its documents came
    // from, or it begins mid-story.
    const kept = (
      rows as unknown as Array<{ id: string; after: { role: string; reason: string } }>
    ).find(
      (r) => r.id === winner.id,
    )!
    expect(kept.after.role).toBe('absorbed')
    expect(kept.after.reason).toBe('Same business, two spellings.')
  })

  it('refuses without a reason, and changes nothing', async () => {
    const winner = await createCustomer(fixture.ctx, { name: 'Keep' })
    const loser = await createCustomer(fixture.ctx, { name: 'Go' })
    await anInvoice(loser.id, 5000)

    await expect(
      mergeParties(fixture.ctx, { side: 'customer', winnerId: winner.id, loserId: loser.id }),
    ).rejects.toThrow(/Why are these one business/)

    const summaries = await listCustomerSummaries(fixture.ctx)
    expect(summaries.find((row) => row.id === loser.id)?.documentCount).toBe(1)
    expect(summaries.find((row) => row.id === loser.id)?.isActive).toBe(true)
  })

  it('merges suppliers by the same rules', async () => {
    const winner = await createVendor(fixture.ctx, { name: 'Twinned Supplies' })
    const loser = await createVendor(fixture.ctx, { name: 'Twinned Supplies Co' })

    await createBill(fixture.ctx, {
      vendorId: loser.id,
      vendorReference: 'TS-1',
      issueDate: '2026-02-01',
      dueDate: '2026-03-03',
      lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: 40_000 }],
    })

    const result = await mergeParties(fixture.ctx, {
      side: 'vendor',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'One supplier, two accounts.',
    })

    expect(result.moved).toEqual([{ table: 'bills', rows: 1 }])
  })

  it('will not reach into another company', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const mine = await createCustomer(fixture.ctx, { name: 'Mine' })
    const theirs = await createCustomer(other.ctx, { name: 'Theirs' })

    await expect(
      mergeParties(fixture.ctx, {
        side: 'customer',
        winnerId: mine.id,
        loserId: theirs.id,
        reason: 'Trying it on.',
      }),
    ).rejects.toThrow(/no longer exists/)
  })
})

/**
 * The tripwire.
 *
 * A merge that repoints twenty-one of twenty-two references leaves a document
 * attached to a record the screens have hidden — silent, irreversible data
 * loss, found months later by somebody reconciling a balance that will not tie.
 *
 * So the registry is checked against the database's own catalogue. Adding a
 * table with a `customer_id` on it and not telling `PARTY_REFERENCES` fails
 * here, with the column named, which is the whole point of writing the list by
 * hand rather than deriving it: there is a moment where somebody decides.
 */
describe('every reference is registered', () => {
  it('names exactly the foreign keys the database has', async () => {
    const rows = (await db.execute(
      sql`select c.confrelid::regclass::text as target,
                 c.conrelid::regclass::text as tbl,
                 a.attname::text as col
          from pg_constraint c
          join unnest(c.conkey) k on true
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
          where c.contype = 'f'
            and c.confrelid::regclass::text in ('customers', 'vendors')`,
    )) as unknown as Array<{ target: string; tbl: string; col: string }>

    for (const side of ['customer', 'vendor'] as const) {
      const inDatabase = rows
        .filter((row) => row.target === `${side}s`)
        // The merge pointer itself is not a document to move: it is how the
        // losing record says where it went.
        .filter((row) => row.col !== 'merged_into_id')
        .map((row) => `${row.tbl}.${row.col}`)
        .sort()

      const registered = PARTY_REFERENCES[side]
        .map((ref) => `${ref.table}.${ref.column}`)
        .sort()

      expect(registered).toEqual(inDatabase)
    }
  })

  it('names only tables and columns that exist', async () => {
    // A typo in the registry would silently move nothing, which reads exactly
    // like a party with no rows in that table.
    const every = [...PARTY_REFERENCES.customer, ...PARTY_REFERENCES.vendor, ...EXCLUSIVE_REFERENCES]

    const rows = (await db.execute(
      sql`select table_name || '.' || column_name as ref
          from information_schema.columns where table_schema = 'public'`,
    )) as unknown as Array<{ ref: string }>

    const known = new Set(rows.map((row) => row.ref))
    for (const ref of every) {
      expect(known.has(`${ref.table}.${ref.column}`)).toBe(true)
    }
  })

  it('every table a merge touches is scoped by company', async () => {
    // The update filters on company_id. A table without one would be updated
    // across every tenant, which is the worst possible failure of this
    // function and the cheapest to rule out.
    const rows = (await db.execute(
      sql`select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'company_id'`,
    )) as unknown as Array<{ table_name: string }>

    const scoped = new Set(rows.map((row) => row.table_name))
    for (const ref of [...PARTY_REFERENCES.customer, ...PARTY_REFERENCES.vendor]) {
      expect(scoped.has(ref.table)).toBe(true)
    }
  })
})

describe('the words for a count', () => {
  /**
   * The browser rendered *"1 recurring invoices"*.
   *
   * Dropping a trailing `s` happens to be right for all twenty-two names in
   * the registry. Asserted rather than assumed, so a table with an irregular
   * plural fails here instead of printing "1 people" at somebody.
   */
  it('says one invoice, not one invoices', () => {
    const line = describeMerge({
      side: 'customer',
      winnerName: 'A',
      loserName: 'B',
      tally: [
        { table: 'recurring_invoices', rows: 1 },
        { table: 'invoices', rows: 4 },
      ],
    })

    expect(line).toContain('1 recurring invoice,')
    expect(line).toContain('4 invoices')
  })

  it('has no registry name whose singular needs more than dropping an s', () => {
    const irregular = [...PARTY_REFERENCES.customer, ...PARTY_REFERENCES.vendor].filter(
      (ref) => !ref.table.endsWith('s') || ref.table.endsWith('ss'),
    )

    expect(irregular).toEqual([])
  })
})
