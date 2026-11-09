import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, clauses, workOrders } from '@/db/schema'
import {
  createClause,
  listClauses,
  reviseClause,
  setClauseActive,
} from '@/modules/studio/service'
import {
  createBom,
  createWorkOrder,
  listBoms,
  requirementsFor,
  setBomActive,
} from '@/modules/manufacturing/service'
import { createServiceItem } from '@/modules/studio/service'
import { setModuleEnabled } from '@/modules/industry/modules'
import { COLUMN_WRITERS, columnWriterFor, writerCandidates } from '@/modules/source/column-writers'
import { RegistryError } from '@/modules/errors/registry'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * Offered, and not offered (Phase 205, spec §7, §15, §5).
 *
 * ## The last two switches, and why they were last
 *
 * Phase 202 narrowed the column census's exclusion for a defaulted column and
 * found **six `isActive` columns nothing could turn off**. Reading each
 * reader split them into two kinds, and that split is what decided the order
 * they were closed in:
 *
 * | | |
 * | --- | --- |
 * | **enforced** | a refusal already written, so the whole gap was the writer. `memberships` (Phase 202), the gift card (203), the till and the practice (204). |
 * | **projections only** | selected to be *displayed* and filtered by nothing, so a writer alone would hand somebody a control with no effect. The clause library and the bill of materials — these two. |
 *
 * An earlier draft of that register had one of them wrong, claiming the recipe
 * a work order is built from was filtered on the column. Reading the two call
 * sites corrected it, and without that correction the cheap closures and the
 * expensive ones would have looked identical.
 *
 * ## One phase, two mechanisms, and the difference is copying against referencing
 *
 * ADR 0204 said *filter first*, and measuring showed the two need the filter
 * in **different places**:
 *
 * - A clause is **copied** into a document the moment somebody adds it — the
 *   block stores `clauseVersionId`, not a clause id, because *"what a client
 *   was shown must not"* change. There is no later moment at which a retired
 *   clause could be acted on, so not offering it is the whole job, and ADR
 *   0021 is satisfied by the schema rather than by a rule.
 * - A work order **references** its recipe for the life of the run:
 *   `requirementsFor` and `completeWorkOrder` look it up by the id the order
 *   already names. Filtering there would cost a half-built batch the recipe it
 *   was costed against, so the recipe stays readable for ever and
 *   `createWorkOrder` refuses to *start* a run against a superseded one.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Ridgeline Works' })
})

async function clause(title = 'Standard terms') {
  const made = await createClause(fixture.ctx, {
    title,
    body: 'Payment within 30 days.',
    approve: true,
  })
  return made.clause
}

async function recipe(name = 'Oak table') {
  await setModuleEnabled(fixture.ctx, 'manufacturing', true)

  const output = await createServiceItem(fixture.ctx, { name: `${name} (finished)` })
  const part = await createServiceItem(fixture.ctx, { name: `${name} top` })

  const bom = await createBom(fixture.ctx, {
    outputItemId: output.id,
    name,
    batchMilli: 1_000,
    components: [{ componentItemId: part.id, quantityMilli: 1_000 }],
  })

  return { bomId: bom.id, outputItemId: output.id }
}

describe('a clause taken out of the library', () => {
  it('stops being offered, and the library still shows it', async () => {
    /**
     * The filter and the writer together, which is the pair ADR 0204 said had
     * to arrive in one phase: `listClauses` defaults to live clauses only, and
     * the Studio asks for everything because it is the one screen that can put
     * one back.
     */
    const kept = await clause('Standard terms')
    const old = await clause('Terms (2019)')

    await setClauseActive(fixture.ctx, { clauseId: old.id, isActive: false })

    const offered = await listClauses(fixture.ctx)
    expect(offered.map((row) => row.id)).toEqual([kept.id])

    const library = await listClauses(fixture.ctx, { includeRetired: true })
    expect(library).toHaveLength(2)
    expect(library.find((row) => row.id === old.id)?.isActive).toBe(false)
  })

  it('is the default, so a screen that forgets the flag is safe', () => {
    /**
     * The reason the option is `includeRetired` rather than `activeOnly`.
     * Three screens read this list: two *offer* clauses for a document and one
     * manages them, and a caller who forgets should get the safe answer.
     *
     * Asserted on the two designer pages by name, because the failure this
     * guards against is a fourth picker added later — and the thing that would
     * make it safe is the default, not a reviewer noticing.
     */
    // Neither designer passes an option at all, which is the point.
    for (const page of [
      'src/app/crm/proposals/[id]/design/page.tsx',
      'src/app/marketing/creative/[id]/page.tsx',
    ]) {
      const source = readFileSync(page, 'utf8')
      expect(source, page).toContain('listClauses(actor)')
      expect(source, page).not.toContain('includeRetired')
    }

    // And the Studio asks for them, under a comment saying why.
    const studio = readFileSync('src/app/studio/page.tsx', 'utf8')
    expect(studio).toContain('listClauses(actor, { includeRetired: true })')
  })

  it('changes no wording anywhere, which a revision does', async () => {
    /**
     * The two controls are deliberately not one. A revision gives new language
     * to the same clause and every document keeps the version it was sent
     * with; a retirement stops the clause being offered and touches no word of
     * any version.
     *
     * So retiring is reversible and leaves the current version exactly as it
     * was — asserted because a "retire" that silently revised to an empty body
     * would pass every other test here.
     */
    const terms = await clause()
    await reviseClause(fixture.ctx, terms.id, { body: 'Payment within 14 days.', approve: true })

    const [before] = await listClauses(fixture.ctx, { includeRetired: true })
    expect(before.body).toBe('Payment within 14 days.')

    await setClauseActive(fixture.ctx, { clauseId: terms.id, isActive: false })

    const [after] = await listClauses(fixture.ctx, { includeRetired: true })
    expect(after.body).toBe('Payment within 14 days.')
    expect(after.versionNumber).toBe(before.versionNumber)

    // And back, because a clause retired by mistake is not a clause deleted.
    await setClauseActive(fixture.ctx, { clauseId: terms.id, isActive: true })
    expect(await listClauses(fixture.ctx)).toHaveLength(1)
  })

  it('records which way it went', async () => {
    const terms = await clause()

    await setClauseActive(fixture.ctx, { clauseId: terms.id, isActive: false })
    await setClauseActive(fixture.ctx, { clauseId: terms.id, isActive: true })

    const actions = (
      await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.companyId, fixture.companyId))
    ).map((row) => row.action)

    expect(actions).toContain('clause.retire')
    expect(actions).toContain('clause.restore')
  })

  it('is scoped, so one company cannot retire another’s wording', async () => {
    const terms = await clause()
    const other = await createCompanyFixture({ name: 'Elsewhere Ltd' })

    await expect(
      setClauseActive(other.ctx, { clauseId: terms.id, isActive: false }),
    ).rejects.toThrow(/not in this library/)

    const [row] = await db
      .select({ isActive: clauses.isActive })
      .from(clauses)
      .where(and(eq(clauses.id, terms.id)))
    expect(row.isActive).toBe(true)
  })
})

describe('a recipe superseded', () => {
  it('cannot start a new run, and the refusal is in the service', async () => {
    /**
     * The enforcement half. The rule is *"you may not start a run against
     * this"*, and a rule that holds only on the screen that remembered to
     * filter is not the rule — so `createWorkOrder` checks it, and the
     * picker's filter is a convenience on top.
     *
     * Nothing validated `bomId` at all before this: not its existence, not its
     * tenant, not its state. The composite foreign key had been doing the
     * first two.
     */
    const { bomId, outputItemId } = await recipe()

    await setBomActive(fixture.ctx, { bomId, isActive: false })

    await expect(
      createWorkOrder(fixture.ctx, { outputItemId, bomId, plannedMilli: 1_000 }),
    ).rejects.toThrow(/has been superseded/)

    // A run with no recipe at all is still allowed — it just has nothing to
    // compare its material against, which was true before this phase.
    const loose = await createWorkOrder(fixture.ctx, { outputItemId, plannedMilli: 1_000 })
    expect(loose.number).toBeDefined()
  })

  it('stays readable for the runs already costed against it', async () => {
    /**
     * The reason the filter is **not** on the read. `requirementsFor` looks
     * the recipe up by the id the work order already names, and a half-built
     * batch that lost the recipe it was costed against is a worse outcome than
     * the gap this phase closes.
     */
    const { bomId, outputItemId } = await recipe()
    const order = await createWorkOrder(fixture.ctx, {
      outputItemId,
      bomId,
      plannedMilli: 2_000,
    })

    const before = await requirementsFor(fixture.ctx, { bomId, quantityMilli: 2_000 })
    expect(before.length).toBeGreaterThan(0)

    await setBomActive(fixture.ctx, { bomId, isActive: false })

    // The recipe is still there, and still says the same thing.
    expect(await requirementsFor(fixture.ctx, { bomId, quantityMilli: 2_000 })).toEqual(before)

    // And the run still names it.
    const [row] = await db
      .select({ bomId: workOrders.bomId })
      .from(workOrders)
      .where(eq(workOrders.id, order.id))
    expect(row.bomId).toBe(bomId)
  })

  it('refuses a recipe that does not exist, which nothing did before', async () => {
    const { outputItemId } = await recipe()

    await expect(
      createWorkOrder(fixture.ctx, {
        outputItemId,
        bomId: '11111111-1111-1111-1111-111111111111',
        plannedMilli: 1_000,
      }),
    ).rejects.toThrow(/No such bill of materials/)
  })

  it('stays on the list so somebody can put it back', async () => {
    const { bomId } = await recipe()

    await setBomActive(fixture.ctx, { bomId, isActive: false })

    const boms = await listBoms(fixture.ctx)
    expect(boms).toHaveLength(1)
    expect(boms[0].isActive).toBe(false)

    await setBomActive(fixture.ctx, { bomId, isActive: true })
    expect((await listBoms(fixture.ctx))[0].isActive).toBe(true)
  })

  it('records which way it went, and is scoped', async () => {
    const { bomId } = await recipe()

    await setBomActive(fixture.ctx, { bomId, isActive: false })

    const actions = (
      await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.companyId, fixture.companyId))
    ).map((row) => row.action)
    expect(actions).toContain('bom.retire')

    const other = await createCompanyFixture({ name: 'Elsewhere Ltd' })
    await setModuleEnabled(other.ctx, 'manufacturing', true)
    await expect(
      setBomActive(other.ctx, { bomId, isActive: true }),
    ).rejects.toThrow(/No such bill of materials/)
  })
})

describe('the picker and the list are different questions', () => {
  it('offers only live recipes while listing every one', () => {
    /**
     * The manufacturing board is one screen serving both purposes from one
     * prop — the work-order `<select>` and the recipe tab — which is why the
     * filter is in the markup there and in the service for clauses, where
     * three different pages consume the list.
     *
     * Asserted on the source because the claim is about *which* list each
     * control is built from, and that is not visible from outside the render.
     */
    const board = readFileSync('src/app/manufacturing/board.tsx', 'utf8')

    // The picker filters.
    expect(board).toContain('.filter((bom) => bom.isActive)')
    // The tab does not: it is where a superseded recipe is seen and restored.
    expect(board).toContain('superseded')
  })
})

describe('what the register says now', () => {
  it('declares neither of them, because both have writers', () => {
    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)

    expect(candidates).not.toContain('clauses.isActive')
    expect(candidates).not.toContain('bills_of_materials.isActive')
    expect(() => columnWriterFor('clauses', 'isActive')).toThrow(RegistryError)
    expect(() => columnWriterFor('bills_of_materials', 'isActive')).toThrow(RegistryError)
  })

  it('has one finding left, and everything else is a write no pattern sees', () => {
    /**
     * The class ADR 0200 nominated, four phases on. Of the 30 candidates the
     * scan still reports, 29 are columns something writes through a spread or
     * a helper's return — which is what the register was built to hold — and
     * **one** is a column nothing writes at all.
     *
     * Asserted rather than described, because "we closed them all" is the kind
     * of claim this process keeps finding to be a count nobody checked.
     */
    const findings = COLUMN_WRITERS.filter((entry) => entry.verdict === 'unwritable')

    expect(findings.map((entry) => `${entry.table}.${entry.columns.join(',')}`)).toEqual([
      'vendors.organizationId',
    ])

    const written = COLUMN_WRITERS.filter((entry) => entry.verdict === 'written')
    expect(written.flatMap((entry) => entry.columns)).toHaveLength(29)
  })
})
