import { beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { invoiceLines, serviceItems } from '@/db/schema'
import { RegistryError } from '@/modules/errors/registry'
import {
  CONVERSION_SHAPES,
  REFERENCE_PROOFS,
  REFERENCE_ROLLOUT,
  proofFor,
  proofOf,
  referenceStands,
  type ReferenceObservation,
} from '@/modules/tenancy/references'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { createServiceItem } from '@/modules/studio/service'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * The id a caller hands in (Phase 170).
 *
 * Phases 149 and 150 audited every write and every read for the guard that
 * keeps it from reaching another tenant's **row**. This is the other question,
 * which they did not cover: a write can be perfectly guarded, landing squarely
 * on the caller's own row, and still store a **reference to somebody else's**.
 *
 * ADR 0169 found that on `invoice_lines.item_id` and could only contain it —
 * the report's join is scoped, so a foreign item groups as "not in this
 * company's catalogue" instead of printing its name. It also said the foreign
 * key "cannot express 'and it must be yours'", which was wrong about the
 * database: a composite key can, because the referencing row's own `company_id`
 * becomes part of the reference.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Okonjo Builders' })
})

/** A reference with nothing holding it up, for the decision tests. */
function unproved(overrides: Partial<ReferenceObservation> = {}): ReferenceObservation {
  return {
    table: 'invoice_lines',
    column: 'item_id',
    target: 'service_items',
    tenantInKey: false,
    everyWriterLooksItUp: false,
    neverSuppliedByCaller: false,
    ...overrides,
  }
}

// --- The measurement, which is the phase ----------------------------------

describe('how many references could point at another tenant', () => {
  it('counts every reference between tenant-scoped tables, and how many carry the tenant', async () => {
    /**
     * Measured from `pg_constraint`, not declared (Phase 126: the count, not a
     * bound). 271 references across 167 company-scoped tables when Phase 170
     * looked, none carrying the tenant; **sixteen** now, after Phase 171 took
     * every reference into `service_items`.
     *
     * The number is asserted so that it moves and says so. Adding a reference
     * raises `total`; converting one raises `composite`. Either way this test
     * fails and somebody reads `REFERENCE_ROLLOUT` — which is the only reason a
     * 271-item backlog is worth writing down at all.
     */
    const rows = await db.execute(sql`
      with scoped as (
        select c.relname as t
          from pg_class c
          join pg_attribute a on a.attrelid = c.oid
         where c.relkind = 'r'
           and a.attname = 'company_id'
           and a.attnum > 0
           and not a.attisdropped
      )
      select count(*)::int as total,
             count(*) filter (where array_length(k.conkey, 1) > 1)::int as composite
        from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class tgt on tgt.oid = k.confrelid
       where k.contype = 'f'
         and src.relname in (select t from scoped)
         and tgt.relname in (select t from scoped)
    `)

    const [measured] = rows as unknown as Array<{ total: number; composite: number }>

    expect(measured.total).toBe(271)
    expect(measured.composite).toBe(16)
  })

  it('leaves no single-column reference into the catalogue at all', async () => {
    /**
     * The claim Phase 171 bought by taking a slice by *referenced* table rather
     * than by referencing one: not "fourteen more are done", which is a
     * sentence about the backlog, but **no row anywhere can name a catalogue
     * item belonging to another company**, which is a sentence about the data.
     *
     * Asserted as zero rather than as a list of sixteen names, because the list
     * would have to be edited every time a table gains a reference and the zero
     * would not — and a reference added tomorrow without the tenant is exactly
     * what this should catch.
     */
    const rows = await db.execute(sql`
      select count(*)::int as single
        from pg_constraint
       where contype = 'f'
         and array_length(conkey, 1) = 1
         and confrelid = 'service_items'::regclass
    `)

    const [measured] = rows as unknown as Array<{ single: number }>
    expect(measured.single).toBe(0)
  })

  it('counts the shapes the slice met, which is what made a sweep wrong', () => {
    /*
      ADR 0170 predicted the conversions would not be uniform and declined to
      sweep. Sixteen references, three shapes — and the six `SET NULL` ones
      would have been broken by the mechanical version.

      Six and not four: the first draft of this counted only the fourteen Phase
      171 converted and asserted a total of sixteen, which is the arithmetic
      failing out loud. The two Phase 170 did are references into the same table
      with the same shape, so they belong in the count; a field named after the
      slice must count the slice.
    */
    expect(CONVERSION_SHAPES.map((shape) => shape.foundInCatalogueSlice)).toEqual([6, 9, 1])
    expect(
      CONVERSION_SHAPES.reduce((sum, shape) => sum + shape.foundInCatalogueSlice, 0),
    ).toBe(16)

    for (const shape of CONVERSION_SHAPES) {
      expect(shape.because.length, shape.key).toBeGreaterThan(180)
    }

    // Exactly one needs the column-list delete rule, which is the whole reason
    // the shapes had to be distinguished.
    expect(
      CONVERSION_SHAPES.filter((shape) => shape.deleteRule.includes('(col)')).map((s) => s.key),
    ).toEqual(['set-null-nullable'])
  })

  it('states the rollout rather than leaving 269 implied', () => {
    // Phase 160's shape for RLS, reused: a phase that converted two and said
    // nothing about the rest would be the partial work this codebase keeps
    // finding in its own history.
    expect(REFERENCE_ROLLOUT.map((stage) => stage.stage)).toEqual([
      'measured',
      'proved where it was found',
      'one referenced table finished',
      'the rest',
    ])

    for (const stage of REFERENCE_ROLLOUT) {
      expect(stage.because.length, stage.stage).toBeGreaterThan(140)
    }
  })
})

// --- What the database now refuses ----------------------------------------

describe('the composite key, which is prevention rather than containment', () => {
  async function anInvoiceWithItem(itemId: string) {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Marine' })
    const revenue = await fixture.account('4000')

    return createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'Framing',
          unitPriceCents: 100_000,
          itemId,
        },
      ],
    })
  }

  it('refuses another company’s catalogue item outright', async () => {
    /**
     * The case ADR 0169 accepted and contained. It is refused now, by the
     * database, with no lookup anywhere in `createInvoice`: the pair
     * `(this company, their item)` does not exist in `service_items`.
     *
     * Phase 116 — a constraint beats a check — and the specific virtue here is
     * that nothing had to be added to the writer. A second writer of
     * `invoice_lines` added next year inherits this; it would have inherited
     * nothing from a lookup in `createInvoice`.
     */
    const other = await createCompanyFixture({ name: 'Somebody Else Ltd' })
    const theirItem = await createServiceItem(other.ctx, {
      name: 'Their framing',
      unitPriceCents: 100_000,
    })

    const refused = await anInvoiceWithItem(theirItem.id).then(
      () => undefined,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause?.constraint_name,
    )

    expect(refused).toBe('invoice_lines_item_tenant_fk')
  })

  it('still accepts the company’s own item', async () => {
    // The other side, so the constraint has been seen to agree as well as
    // disagree (Phase 121). A key that refused everything would pass the test
    // above.
    const mine = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    const invoice = await anInvoiceWithItem(mine.id)
    const [line] = await db
      .select({ itemId: invoiceLines.itemId })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))

    expect(line.itemId).toBe(mine.id)
  })

  it('still refuses an id that names nothing at all', async () => {
    const refused = await anInvoiceWithItem('00000000-0000-4000-8000-000000000000').then(
      () => undefined,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause?.constraint_name,
    )

    expect(refused).toBe('invoice_lines_item_tenant_fk')
  })

  it('clears the line’s item when the catalogue entry is deleted', async () => {
    /**
     * The part of a composite tenant key that is not a mechanical substitution,
     * and the reason `REFERENCE_ROLLOUT` says the other 269 cannot be done by
     * search and replace.
     *
     * A bare `ON DELETE SET NULL` nulls *every* column of the reference, and
     * `company_id` is `NOT NULL` — so this delete would fail instead of
     * clearing the line. `ON DELETE SET NULL (item_id)` names the column.
     */
    const mine = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })
    const invoice = await anInvoiceWithItem(mine.id)

    await db.delete(serviceItems).where(eq(serviceItems.id, mine.id))

    const [line] = await db
      .select({ itemId: invoiceLines.itemId, description: invoiceLines.description })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))

    expect(line.itemId).toBeNull()
    expect(line.description).toBe('Framing')
  })
})

describe('the slice taken by referenced table (Phase 171)', () => {
  it('refuses another company’s item on a reference nothing else guarded', async () => {
    /**
     * `time_entries.item_id` rather than an invoice line, deliberately. The two
     * Phase 170 converted were the two somebody had already found; this one was
     * converted because it points at the same table, and nothing about *it* had
     * ever been examined.
     *
     * That is the argument for slicing by referenced table: the references
     * nobody has looked at are the ones most likely to be unguarded, and taking
     * a whole target catches them without having to guess which.
     */
    const other = await createCompanyFixture({ name: 'Somebody Else Ltd' })
    const theirItem = await createServiceItem(other.ctx, {
      name: 'Their framing',
      unitPriceCents: 100_000,
    })

    const { timeEntries } = await import('@/db/schema')
    const refused = await db
      .insert(timeEntries)
      .values({
        companyId: fixture.companyId,
        userId: fixture.userId,
        workedOn: '2026-06-01',
        minutes: 60,
        description: 'Site visit',
        itemId: theirItem.id,
      })
      .then(
        () => undefined,
        (error: unknown) =>
          (error as { cause?: { constraint_name?: string } }).cause?.constraint_name,
      )

    expect(refused).toBe('time_entries_item_tenant_fk')
  })

  it('still lets a catalogue item be deleted out from under a time entry', async () => {
    /**
     * Shape one, and the assertion that a mechanical sweep would have failed.
     * `time_entries.item_id` is `SET NULL`, so the composite key needs
     * `ON DELETE SET NULL (item_id)` — a bare `SET NULL` would try to null
     * `company_id` too and the delete would be refused.
     *
     * A wrong delete rule is wrong only on the day somebody deletes something,
     * which is why this is asserted and not reasoned about.
     */
    const mine = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    const { timeEntries } = await import('@/db/schema')
    const [entry] = await db
      .insert(timeEntries)
      .values({
        companyId: fixture.companyId,
        userId: fixture.userId,
        workedOn: '2026-06-01',
        minutes: 60,
        description: 'Site visit',
        itemId: mine.id,
      })
      .returning()

    await db.delete(serviceItems).where(eq(serviceItems.id, mine.id))

    const [after] = await db
      .select({ itemId: timeEntries.itemId, minutes: timeEntries.minutes })
      .from(timeEntries)
      .where(eq(timeEntries.id, entry.id))

    expect(after.itemId).toBeNull()
    expect(after.minutes).toBe(60)
  })

  it('renamed the constraints Phase 169 left saying service_item_id', async () => {
    /**
     * A side effect rather than the point, and found by reading
     * `pg_constraint` to get the DROPs right rather than by looking for it.
     *
     * Phase 169 renamed three columns to `item_id` and renamed the index it had
     * created itself, leaving the constraints Postgres and Drizzle had named —
     * the same small untruth in the catalogue it had just argued against, one
     * object type over.
     */
    const rows = await db.execute(sql`
      select count(*)::int as stale
        from pg_constraint
       where conname like '%service_item_id%'
    `)

    const [measured] = rows as unknown as Array<{ stale: number }>
    expect(measured.stale).toBe(0)
  })
})

// --- The vocabulary, and what each proof survives -------------------------

describe('what holds a stored reference up', () => {
  it('argues every proof and says what it survives', () => {
    // Phase 101's device. The `survives` field is the one that does the work
    // here: all four are "a reason to trust the reference" and only one of them
    // is a reason that outlives the function it was written in.
    for (const proof of REFERENCE_PROOFS) {
      expect(proof.because.length, proof.key).toBeGreaterThan(180)
      expect(proof.survives.length, proof.key).toBeGreaterThan(40)
    }
  })

  it('declares exactly one proof the database enforces', () => {
    // The distinction the whole phase turns on, asserted rather than left to
    // the prose: three of the four are properties of code, and code is what
    // moves.
    const enforced = REFERENCE_PROOFS.filter((proof) => proof.enforcedByDatabase)

    expect(enforced.map((proof) => proof.key)).toEqual(['composite-key'])
  })

  it('takes the strongest proof a reference actually has', () => {
    expect(proofOf(unproved({ tenantInKey: true }))).toBe('composite-key')
    expect(proofOf(unproved({ neverSuppliedByCaller: true }))).toBe('derived')
    expect(proofOf(unproved({ everyWriterLooksItUp: true }))).toBe('scoped-lookup')
    expect(proofOf(unproved())).toBe('unproved')

    // A composite key wins over a lookup, which is not a tie-break but the
    // point: once the database refuses the row, the lookup is belt and braces.
    expect(proofOf(unproved({ tenantInKey: true, everyWriterLooksItUp: true }))).toBe(
      'composite-key',
    )
  })

  it('refuses a claim measurement does not support', () => {
    const verdict = referenceStands({ observation: unproved(), claimed: 'composite-key' })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('retire a real guard in favour of nothing')
  })

  it('reports a claim that is weaker than the truth as a stale register', () => {
    // Harmless today and still wrong: Phase 135's lesson is that a declaration
    // which has stopped describing the code reads exactly like one that does.
    const verdict = referenceStands({
      observation: unproved({ tenantInKey: true }),
      claimed: 'scoped-lookup',
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('describing code that has moved on')
  })

  it('accepts a claim that measures true', () => {
    expect(
      referenceStands({ observation: unproved({ tenantInKey: true }), claimed: 'composite-key' }),
    ).toEqual({ ok: true, proof: 'composite-key' })
  })

  it('throws on a proof nobody declared, naming the ones that exist', () => {
    expect(() => proofFor('trust-the-caller')).toThrow(RegistryError)

    try {
      proofFor('trust-the-caller')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('REFERENCE_PROOFS')
      expect((error as RegistryError).message).toContain('composite-key')
    }
  })
})
