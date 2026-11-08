import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { serviceItems } from '@/db/schema'
import { RegistryError } from '@/modules/errors/registry'
import {
  COLUMN_WRITERS,
  columnWriterFor,
  columnsScanned,
  writerCandidates,
} from '@/modules/source/column-writers'
import { declarationOf } from '@/modules/source/enclosing'
import { createContact, createOrganization, updateOrganization } from '@/modules/crm/opportunities'
import { segmentSummary } from '@/modules/marketing/audience'
import { inventoryAccounts, setItemPostingAccounts } from '@/modules/inventory/service'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * Columns with a reader and no writer, measured as a class (Phase 201, §19).
 *
 * ## What ADR 0200 asked for
 *
 * Phase 200 wrote one narrow check — a form's field list against one table's
 * columns — and it **named two columns the author had not noticed**, both read
 * by `letterhead.ts` and put on every document a client sees. Three in one
 * phase by accident of writing one check against one form, so ADR 0200 asked
 * the question of the whole schema instead: *which columns does something read
 * that nothing lets a person fill in?*
 *
 * **2,179 columns across 185 tables. Twenty-seven candidates. Four findings.**
 *
 * ## Why the register is a register and not an assertion
 *
 * Because *"has a writer"* is not decidable by reading the source. Seven
 * mechanisms write a column invisibly to a pattern, and finding each one
 * needed the previous one fixed first — the shape of Phases 196–198 again. Two
 * are undecidable by regex at all:
 *
 * - a **spread**, `.values({ companyId, ...input })`, writes every key of a
 *   type;
 * - a **helper's return**, `.values(decisionFor(input))`, writes a whole row
 *   with no key visible at the call.
 *
 * So the scan produces candidates and `COLUMN_WRITERS` says, per mechanism,
 * which of them are written and where. The rule asserted below is that every
 * candidate is **declared or fixed**, in both directions: an entry for a
 * column the scan no longer reports is removed rather than left to excuse it,
 * which is ADR 0134's difference between a check and an excuse.
 *
 * ## The two closures are asserted by absence
 *
 * `organizations.sizeBand` and `service_items.inventoryAccountId` had readers
 * and no writers and are closed in this phase. They are not in the register,
 * and the test that they are **not candidates** is what proves the editors
 * reach the column — a form field asserted to exist proves only that a form
 * field exists (Phase 200's near miss, fed a prompt an empty string).
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Blackwater Joinery' })
})

describe('the class, measured', () => {
  it('scanned the whole schema, and the figures are the ones quoted', () => {
    /**
     * Asserted exactly rather than as a bound (Phase 126). A floor would pass
     * against a scan that silently stopped reading half the schema files,
     * which is the failure this phase's own first drafts kept producing: a
     * denominator quoted as a total.
     */
    expect(columnsScanned()).toEqual({ tables: 185, columns: 2179 })
    /*
      27 when this phase measured it, and 35 since Phase 202 narrowed the
      exclusion for a defaulted column — see `schemaColumns`. The eight it
      added are the kind this phase was built to find, which its own exclusion
      had made invisible, and the figure is corrected here rather than relaxed
      to a bound (Phase 126). 34 since Phase 203 closed one of the eight, and 32
      since Phase 204 closed the two remaining enforced switches.
    */
    expect(writerCandidates()).toHaveLength(32)
  })

  it('declares every candidate', () => {
    // The register's whole rule. A column the scan reports and nobody has
    // looked at fails here with its own name in the message.
    for (const candidate of writerCandidates()) {
      expect(() => columnWriterFor(candidate.table, candidate.column),
        `${candidate.table}.${candidate.column}`).not.toThrow()
    }
  })

  it('declares nothing the scan no longer reports', () => {
    /**
     * The other direction, and the one that keeps the register honest. An
     * entry outliving the candidate it explains is a sentence excusing a
     * column that now has a visible writer — and the next person reads it as
     * still true (ADR 0134, Phase 185).
     */
    const candidates = new Set(
      writerCandidates().map((candidate) => `${candidate.table}.${candidate.column}`),
    )

    const stale = COLUMN_WRITERS.flatMap((entry) =>
      entry.columns
        .filter((column) => !candidates.has(`${entry.table}.${column}`))
        .map((column) => `${entry.table}.${column}`),
    )

    expect(stale).toEqual([])
  })

  it('refuses a column nobody has argued about', () => {
    // `companies.name` is written in a dozen places and is not a candidate, so
    // asking about it is asking the wrong question — which the registry says
    // rather than answering with a default (Phase 101).
    expect(() => columnWriterFor('companies', 'name')).toThrow(RegistryError)
    expect(() => columnWriterFor('companies', 'name')).toThrow(/No writer is declared/)
  })

  it('argues each entry rather than labelling it', () => {
    // Phase 199's floor, for the same reason: a `because` of four words is a
    // category, and a register of categories excuses rather than explains.
    for (const entry of COLUMN_WRITERS) {
      expect(entry.because.length, entry.table).toBeGreaterThan(140)
      if (entry.verdict === 'written') expect(entry.writtenBy, entry.table).toMatch(/^src\//)
      else expect(entry.writtenBy, entry.table).toBe('')
    }
  })

  it('still reports a column that genuinely has nothing', () => {
    /**
     * The non-vacuity check (Phase 121). A scan that found nothing would pass
     * every assertion above, so one column known by reading to have no writer
     * at all has to still be in the answer.
     *
     * This was `memberships.permissionOverrides` when the phase was written.
     * **Phase 202 closed it**, which is the right reason for a non-vacuity
     * check to need moving — so it is `vendors.organizationId` now, read by
     * `engagement/outbound.ts` so a letter to a supplier also reaches the CRM
     * record of the client that supplier is, and written by nothing.
     */
    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)

    expect(candidates).toContain('vendors.organizationId')
    expect(columnWriterFor('vendors', 'organizationId').verdict).toBe('unwritable')
  })
})

describe('what counts as a writer', () => {
  it('reads a declaration past the end of its first line', () => {
    /**
     * Phase 197 took a local declaration to the end of its line, on the
     * grounds that every one in the repository was a single-line ternary.
     * Phase 201's second caller found that false: `payroll/sales-tax.ts`
     * builds its rows with `const rows = input.lines.map((line) => {` and
     * **four columns of `document_tax_lines` looked unwritten**, two of them
     * `notNull` — a table nothing could insert into, which is not a thing a
     * working application has.
     *
     * Asserted on synthetic source rather than on the tree, because on the
     * tree the old behaviour and the new one both reach *a* conclusion and
     * only one of them is right. The same lesson as Phase 197's own off-by-a-
     * prefix bug, which the real tree hid and a made-up string caught.
     */
    const source = [
      'function build(input) {',
      '  const rows = input.lines.map((line) => ({',
      '    taxCodeId: line.taxCodeId,',
      '    documentType: input.kind,',
      '  }))',
      '  return insert(rows)',
      '}',
    ].join('\n')

    const declaration = declarationOf(source, source.indexOf('insert(rows)'), 'rows')

    expect(declaration).toContain('taxCodeId')
    expect(declaration).toContain('documentType')
    // And it stops at the declaration rather than swallowing the return.
    expect(declaration).not.toContain('return')
  })

  it('keeps a single-line declaration exactly as Phase 197 read it', () => {
    // The generalisation has to be one. `isolation-scan` resolves a table held
    // in a variable through this same primitive, and every site it reads is
    // this shape — two answers to one question would be the defect.
    const source = [
      'async function remove(kind) {',
      "  const table = kind === 'customer' ? customers : vendors",
      '  await db.delete(table)',
      '}',
    ].join('\n')

    expect(declarationOf(source, source.indexOf('db.delete'), 'table')).toBe(
      "const table = kind === 'customer' ? customers : vendors",
    )
  })
})

describe('the segment filter that could only match nothing', () => {
  /**
   * `organizations.sizeBand` was listed in `SEGMENT_FIELDS`, had a `case` in
   * `fieldValue`, was selected by `loadCandidates` and was labelled "Size
   * band" on the segment workspace. No screen set it, so a marketer could
   * build an audience on company size and get an empty one back with nothing
   * to say why. Worse than an unused column, because the interface offered the
   * filter.
   */
  it('is no longer a column the scan can find no writer for', () => {
    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)

    expect(candidates).not.toContain('organizations.sizeBand')
    // And nothing in the register claims to explain it, which would be the
    // other way to make the assertion above pass.
    expect(() => columnWriterFor('organizations', 'sizeBand')).toThrow(RegistryError)
  })

  it('is set when a client is added and corrected afterwards', async () => {
    const created = await createOrganization(fixture.ctx, {
      name: 'Maldon Sailing Club',
      sizeBand: 'small',
    })
    expect(created.sizeBand).toBe('small')

    const corrected = await updateOrganization(fixture.ctx, created.id, { sizeBand: 'medium' })
    expect(corrected.sizeBand).toBe('medium')

    // A partial save must not blank it — the rule `diffParty` exists for.
    const untouched = await updateOrganization(fixture.ctx, created.id, { city: 'Maldon' })
    expect(untouched.sizeBand).toBe('medium')
  })

  it('makes the audience the filter promised', async () => {
    /**
     * The assertion that bites. A form field and a column are not the point:
     * the point is that `sizeBand: is medium` returns somebody, which it could
     * not do for any company on any data before this phase.
     */
    const club = await createOrganization(fixture.ctx, {
      name: 'Maldon Sailing Club',
      sizeBand: 'medium',
    })
    const yard = await createOrganization(fixture.ctx, {
      name: 'Tollesbury Boatyard',
      sizeBand: 'small',
    })

    await createContact(fixture.ctx, {
      organizationId: club.id,
      firstName: 'Ada',
      email: 'ada@maldon.test',
      emailConsent: 'subscribed',
    })
    await createContact(fixture.ctx, {
      organizationId: yard.id,
      firstName: 'Bram',
      email: 'bram@tollesbury.test',
      emailConsent: 'subscribed',
    })

    const summary = await segmentSummary(fixture.ctx, {
      matchType: 'all',
      rules: [{ field: 'sizeBand', operator: 'is', value: 'medium' }],
      lostOpportunityNurture: false,
    })

    // One of the two, and reachable: the filter discriminates rather than
    // matching everybody, and the audience it returns can actually be sent to.
    expect(summary).toMatchObject({ total: 1, contactable: 1 })

    // And the same definition with a band nobody is in still returns nobody,
    // so the assertion above is not passing on a matcher that ignores the rule.
    expect(
      await segmentSummary(fixture.ctx, {
        matchType: 'all',
        rules: [{ field: 'sizeBand', operator: 'is', value: 'enormous' }],
        lostOpportunityNurture: false,
      }),
    ).toMatchObject({ total: 0 })
  })
})

describe('the posting account nobody could choose', () => {
  /**
   * `service_items.inventoryAccountId` was read by `inventoryAccounts` to
   * choose where stock sits, and by `reconcileInventory` — which collects
   * every account any item names so the subledger check does not cry wolf on a
   * manufacturer with raw materials on one line and finished goods on another.
   * Its docstring said that is what such a business *does*. Nothing set it
   * outside the seed, so every real company's stock went to 1400.
   */
  it('is no longer a column the scan can find no writer for', () => {
    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)

    expect(candidates).not.toContain('service_items.inventoryAccountId')
    expect(() => columnWriterFor('service_items', 'inventoryAccountId')).toThrow(RegistryError)
  })

  it('changes where one item posts, and back to the standard chart', async () => {
    const [item] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        name: 'Oak plank',
        isInventoried: true,
      })
      .returning()

    const rawMaterials = await fixture.account('1400')
    const cogs = await fixture.account('5000')
    const shrinkage = await fixture.account('5400')

    // Before: no override, so the chart decides.
    const standard = await inventoryAccounts(fixture.companyId, item)
    expect(standard.inventoryId).toBe(rawMaterials.id)
    expect(standard.cogsId).toBe(cogs.id)

    /*
      Pointed at an account that is deliberately not 1400. 5400 Inventory
      Shrinkage is a strange place to carry stock and that is the point: the
      column is honoured because the item names it, not because the number
      looks like an inventory account.
    */
    const moved = await setItemPostingAccounts(fixture.ctx, {
      itemId: item.id,
      inventoryAccountId: shrinkage.id,
      cogsAccountId: null,
    })

    expect((await inventoryAccounts(fixture.companyId, moved)).inventoryId).toBe(shrinkage.id)
    // The one left null still falls through to the chart rather than to the
    // other override.
    expect((await inventoryAccounts(fixture.companyId, moved)).cogsId).toBe(cogs.id)

    const cleared = await setItemPostingAccounts(fixture.ctx, {
      itemId: item.id,
      inventoryAccountId: null,
      cogsAccountId: null,
    })

    expect(cleared.inventoryAccountId).toBeNull()
    expect((await inventoryAccounts(fixture.companyId, cleared)).inventoryId).toBe(
      rawMaterials.id,
    )

    // Scoped: the write is by id, and the id is somebody else's.
    const other = await createCompanyFixture({ name: 'Elsewhere Ltd' })
    await expect(
      setItemPostingAccounts(other.ctx, {
        itemId: item.id,
        inventoryAccountId: null,
        cogsAccountId: null,
      }),
    ).rejects.toThrow(/not on these books/)
  })

  it('leaves the item unchanged when a row from another company is named', async () => {
    const [item] = await db
      .insert(serviceItems)
      .values({ companyId: fixture.companyId, name: 'Brass screw', isInventoried: true })
      .returning()

    const shrinkage = await fixture.account('5400')
    await setItemPostingAccounts(fixture.ctx, {
      itemId: item.id,
      inventoryAccountId: shrinkage.id,
      cogsAccountId: null,
    })

    const other = await createCompanyFixture({ name: 'Elsewhere Ltd' })
    await expect(
      setItemPostingAccounts(other.ctx, {
        itemId: item.id,
        inventoryAccountId: null,
        cogsAccountId: null,
      }),
    ).rejects.toThrow()

    // The refusal is not a silent no-op: the row somebody else tried to clear
    // still carries what its owner set.
    const [after] = await db
      .select({ account: serviceItems.inventoryAccountId })
      .from(serviceItems)
      .where(eq(serviceItems.id, item.id))

    expect(after.account).toBe(shrinkage.id)
  })
})

describe('the two it does not close', () => {
  it('no longer declares §14’s granular grants, because Phase 202 built them', () => {
    /**
     * This phase declared `memberships.permissionOverrides` and nominated it:
     * §14's per-permission grants and revocations, read into the actor,
     * parsed, and *applied* by `effectivePermissions`, with nothing anywhere
     * able to write one. It also took on an obligation — ADR 0199's §14
     * register entry claimed those grants for a column nothing could write —
     * and discharged it by correcting the entry.
     *
     * `updateMembership` writes them now, so the entry is **gone**, and this
     * asserts the going rather than leaving a sentence that reads as still
     * true. A register entry outliving its candidate is the excuse ADR 0134
     * names, and the register's own two-direction test above would fail on it;
     * this says so by name, so the reason is recorded where somebody looking
     * for the grants will find it.
     */
    expect(() => columnWriterFor('memberships', 'permissionOverrides')).toThrow(RegistryError)
    expect(writerCandidates().map((row) => `${row.table}.${row.column}`)).not.toContain(
      'memberships.permissionOverrides',
    )
  })

  it('says the supplier who is also a client cannot be linked', () => {
    /**
     * `vendors.organizationId` is read by `engagement/outbound.ts` so a letter
     * to a supplier also lands on that client's CRM timeline — the firm that
     * both buys from you and sells to you, which `engagement/filing.ts` spends
     * a page on. The customer side is written when an opportunity is won;
     * there is no such path for a supplier, and the correction screen is driven
     * by a registry of text fields, so a link to a CRM record is a new kind of
     * field rather than one more entry.
     */
    const entry = columnWriterFor('vendors', 'organizationId')

    expect(entry.verdict).toBe('unwritable')
    expect(entry.because).toContain('VENDOR_FIELDS')
  })
})
