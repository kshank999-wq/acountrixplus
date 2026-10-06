import { beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { invoiceLines, serviceItems } from '@/db/schema'
import { RegistryError } from '@/modules/errors/registry'
import {
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
     * bound). 271 single-column references across 167 company-scoped tables
     * when Phase 170 looked, and **two** now carrying the tenant.
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
    expect(measured.composite).toBe(2)
  })

  it('names the two that carry it, so the pair is not a coincidence', async () => {
    const rows = await db.execute(sql`
      select conrelid::regclass::text as table_name
        from pg_constraint
       where contype = 'f'
         and array_length(conkey, 1) > 1
         and confrelid = 'service_items'::regclass
    `)

    const tables = (rows as unknown as Array<{ table_name: string }>)
      .map((row) => row.table_name)
      .sort()

    expect(tables).toEqual(['bill_lines', 'invoice_lines'])
  })

  it('states the rollout rather than leaving 269 implied', () => {
    // Phase 160's shape for RLS, reused: a phase that converted two and said
    // nothing about the rest would be the partial work this codebase keeps
    // finding in its own history.
    expect(REFERENCE_ROLLOUT.map((stage) => stage.stage)).toEqual([
      'measured',
      'proved where it was found',
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
