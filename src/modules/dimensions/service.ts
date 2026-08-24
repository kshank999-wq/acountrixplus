import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  dimensionDefaults,
  dimensionValues,
  dimensions,
  journalEntries,
  journalLineDimensions,
  journalLines,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'

/**
 * User-defined accounting dimensions (spec §13).
 *
 * A dimension is a way of slicing the books that is not an account and not a
 * job: a location, a department, a class, a restricted fund. The model is in
 * `db/schema/dimensions.ts`; this is what creates them, attaches them to
 * journal lines, and resolves the defaults that save somebody tagging every
 * line of every bill by hand.
 */

export type DimensionRequirement = 'optional' | 'expected'

export type Dimension = {
  id: string
  name: string
  code: string
  description: string | null
  requirement: DimensionRequirement
  isActive: boolean
  sortOrder: number
}

export type DimensionValue = {
  id: string
  dimensionId: string
  code: string
  name: string
  parentId: string | null
  isActive: boolean
  sortOrder: number
}

/** What a dimension value can be attached to as a default. */
export const DEFAULT_OWNER_TYPES = [
  'financial_account',
  'chart_account',
  'customer',
  'vendor',
  'project',
] as const

export type DefaultOwnerType = (typeof DEFAULT_OWNER_TYPES)[number]

/** Raised when a dimension assignment does not make sense. */
export class DimensionError extends DomainError {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'DimensionError'
  }
}

// --- The dimensions themselves ---------------------------------------------

export async function listDimensions(
  ctx: ActorContext,
  opts: { includeInactive?: boolean } = {},
): Promise<Dimension[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select()
    .from(dimensions)
    .where(
      scoped(ctx, dimensions, opts.includeInactive ? undefined : eq(dimensions.isActive, true)),
    )
    .orderBy(asc(dimensions.sortOrder), asc(dimensions.name))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    requirement: row.requirement,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  }))
}

export async function createDimension(
  ctx: ActorContext,
  input: {
    name: string
    code: string
    description?: string | null
    requirement?: DimensionRequirement
    sortOrder?: number
  },
): Promise<Dimension> {
  requirePermission(ctx, 'accounting:journal')

  const code = normalizeCode(input.code)
  if (!code) throw new DimensionError('A dimension needs a short code, like LOC or DEPT.')

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(dimensions)
      .values({
        companyId: ctx.companyId,
        name: input.name.trim(),
        code,
        description: input.description ?? null,
        requirement: input.requirement ?? 'optional',
        sortOrder: input.sortOrder ?? 0,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'dimension.create',
        entityType: 'dimension',
        entityId: row.id,
        after: { name: row.name, code: row.code, requirement: row.requirement },
      },
      tx,
    )

    return {
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      requirement: row.requirement,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    }
  })
}

/**
 * Renames a dimension, changes its expectation, or retires it.
 *
 * Retiring is `isActive = false` rather than a delete. Every assignment ever
 * made points at this row, and "we tracked Region until 2027" is a fact about
 * the books that a deletion would erase along with every historic report's
 * ability to explain itself.
 */
export async function updateDimension(
  ctx: ActorContext,
  dimensionId: string,
  patch: {
    name?: string
    description?: string | null
    requirement?: DimensionRequirement
    isActive?: boolean
    sortOrder?: number
  },
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(dimensions)
      .where(scoped(ctx, dimensions, eq(dimensions.id, dimensionId)))
      .limit(1)

    if (!before) throw new DimensionError('That dimension does not exist.')

    await tx
      .update(dimensions)
      .set({
        name: patch.name?.trim() ?? before.name,
        description: patch.description === undefined ? before.description : patch.description,
        requirement: patch.requirement ?? before.requirement,
        isActive: patch.isActive ?? before.isActive,
        sortOrder: patch.sortOrder ?? before.sortOrder,
        updatedAt: new Date(),
      })
      .where(scoped(ctx, dimensions, eq(dimensions.id, dimensionId)))

    await recordAudit(
      ctx,
      {
        action: 'dimension.update',
        entityType: 'dimension',
        entityId: dimensionId,
        before: { name: before.name, requirement: before.requirement, isActive: before.isActive },
        after: patch,
      },
      tx,
    )
  })
}

// --- Values ----------------------------------------------------------------

export async function listDimensionValues(
  ctx: ActorContext,
  opts: { dimensionId?: string; includeInactive?: boolean } = {},
): Promise<DimensionValue[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select()
    .from(dimensionValues)
    .where(
      scoped(
        ctx,
        dimensionValues,
        opts.dimensionId ? eq(dimensionValues.dimensionId, opts.dimensionId) : undefined,
        opts.includeInactive ? undefined : eq(dimensionValues.isActive, true),
      ),
    )
    .orderBy(asc(dimensionValues.sortOrder), asc(dimensionValues.code))

  return rows.map((row) => ({
    id: row.id,
    dimensionId: row.dimensionId,
    code: row.code,
    name: row.name,
    parentId: row.parentId,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  }))
}

export async function createDimensionValue(
  ctx: ActorContext,
  input: {
    dimensionId: string
    code: string
    name: string
    parentId?: string | null
    sortOrder?: number
  },
): Promise<DimensionValue> {
  requirePermission(ctx, 'accounting:journal')

  const code = normalizeCode(input.code)
  if (!code) throw new DimensionError('A value needs a short code.')

  return db.transaction(async (tx) => {
    const [dimension] = await tx
      .select({ id: dimensions.id })
      .from(dimensions)
      .where(scoped(ctx, dimensions, eq(dimensions.id, input.dimensionId)))
      .limit(1)

    if (!dimension) throw new DimensionError('That dimension does not exist.')

    if (input.parentId) {
      const [parent] = await tx
        .select({ dimensionId: dimensionValues.dimensionId })
        .from(dimensionValues)
        .where(scoped(ctx, dimensionValues, eq(dimensionValues.id, input.parentId)))
        .limit(1)

      // A hierarchy that crosses dimensions is not a hierarchy: rolling
      // "Portland" up to "Marketing" would produce a total that means nothing.
      if (!parent || parent.dimensionId !== input.dimensionId) {
        throw new DimensionError('A value can only roll up to another value of the same dimension.')
      }
    }

    const [row] = await tx
      .insert(dimensionValues)
      .values({
        companyId: ctx.companyId,
        dimensionId: input.dimensionId,
        code,
        name: input.name.trim(),
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning()

    return {
      id: row.id,
      dimensionId: row.dimensionId,
      code: row.code,
      name: row.name,
      parentId: row.parentId,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    }
  })
}

export async function updateDimensionValue(
  ctx: ActorContext,
  valueId: string,
  patch: { name?: string; isActive?: boolean; sortOrder?: number },
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  const [before] = await db
    .select()
    .from(dimensionValues)
    .where(scoped(ctx, dimensionValues, eq(dimensionValues.id, valueId)))
    .limit(1)

  if (!before) throw new DimensionError('That value does not exist.')

  await db
    .update(dimensionValues)
    .set({
      name: patch.name?.trim() ?? before.name,
      isActive: patch.isActive ?? before.isActive,
      sortOrder: patch.sortOrder ?? before.sortOrder,
      updatedAt: new Date(),
    })
    .where(scoped(ctx, dimensionValues, eq(dimensionValues.id, valueId)))
}

// --- Assignment ------------------------------------------------------------

/**
 * A dimension assignment as the posting paths pass it around.
 *
 * `Record<dimensionId, dimensionValueId>` rather than an array of pairs,
 * because "one value per dimension" is the model's central constraint and a
 * map cannot express a violation of it. The database enforces it too; making
 * it unrepresentable in the type means the enforcement is never reached.
 */
export type DimensionAssignment = Record<string, string>

/**
 * Writes a line's dimension values.
 *
 * Called from inside the posting transaction, so a line and its dimensions
 * arrive together or not at all. A line that committed without its values
 * would be an Unassigned row on a report that nobody could explain, because
 * the person who posted it did assign one.
 */
export async function assignLineDimensions(
  ctx: ActorContext,
  lines: Array<{ journalLineId: string; assignment: DimensionAssignment }>,
  exec: Executor,
): Promise<void> {
  const rows = lines.flatMap(({ journalLineId, assignment }) =>
    Object.entries(assignment)
      .filter(([, valueId]) => Boolean(valueId))
      .map(([dimensionId, dimensionValueId]) => ({
        companyId: ctx.companyId,
        journalLineId,
        dimensionId,
        dimensionValueId,
      })),
  )

  if (rows.length === 0) return

  // One validation query for the whole entry rather than one per line: a
  // supplier bill across twelve sites should not cost twelve round trips.
  //
  // Distinct *pairs*, not a merged map. Merging would let line 2's Location
  // overwrite line 1's and carry it past the check unexamined — which is
  // precisely the entry a bill spanning several sites produces.
  await validatePairs(
    ctx,
    rows.map((row) => [row.dimensionId, row.dimensionValueId] as const),
    exec,
  )

  await exec
    .insert(journalLineDimensions)
    .values(rows)
    // Re-posting the same line's dimensions is a no-op rather than a crash.
    // The unique index is still what guarantees one value per dimension; this
    // only decides what happens when the same pair arrives twice.
    .onConflictDoNothing({
      target: [journalLineDimensions.journalLineId, journalLineDimensions.dimensionId],
    })
}

/**
 * Checks that every value belongs to the dimension it is filed under, and to
 * this company.
 *
 * Both halves matter. A value from another tenant is an isolation failure; a
 * value from the wrong dimension of the *same* tenant is worse in a quieter
 * way — the report would show "Downtown" as a Department, and the totals would
 * still foot, so nothing would look wrong.
 */
async function validatePairs(
  ctx: ActorContext,
  pairs: ReadonlyArray<readonly [dimensionId: string, valueId: string]>,
  exec: Executor,
): Promise<void> {
  const valueIds = [...new Set(pairs.map(([, valueId]) => valueId).filter(Boolean))]
  if (valueIds.length === 0) return

  const rows = await exec
    .select({ id: dimensionValues.id, dimensionId: dimensionValues.dimensionId })
    .from(dimensionValues)
    .where(scoped(ctx, dimensionValues, inArray(dimensionValues.id, valueIds)))

  const byId = new Map(rows.map((row) => [row.id, row.dimensionId]))

  for (const [dimensionId, valueId] of pairs) {
    if (!valueId) continue
    const owner = byId.get(valueId)
    if (!owner) throw new DimensionError('That dimension value does not exist on these books.')
    if (owner !== dimensionId) {
      throw new DimensionError('That value belongs to a different dimension.')
    }
  }
}

function validateAssignment(
  ctx: ActorContext,
  assignment: DimensionAssignment,
  exec: Executor,
): Promise<void> {
  return validatePairs(
    ctx,
    Object.entries(assignment).filter(([, valueId]) => Boolean(valueId)) as Array<
      [string, string]
    >,
    exec,
  )
}

/** Every dimension value on a set of journal lines, keyed by line. */
export async function dimensionsForLines(
  ctx: ActorContext,
  lineIds: string[],
  exec: Executor = db,
): Promise<Map<string, DimensionAssignment>> {
  if (lineIds.length === 0) return new Map()

  const rows = await exec
    .select({
      journalLineId: journalLineDimensions.journalLineId,
      dimensionId: journalLineDimensions.dimensionId,
      dimensionValueId: journalLineDimensions.dimensionValueId,
    })
    .from(journalLineDimensions)
    .where(
      scoped(ctx, journalLineDimensions, inArray(journalLineDimensions.journalLineId, lineIds)),
    )

  const byLine = new Map<string, DimensionAssignment>()
  for (const row of rows) {
    const existing = byLine.get(row.journalLineId) ?? {}
    existing[row.dimensionId] = row.dimensionValueId
    byLine.set(row.journalLineId, existing)
  }
  return byLine
}

// --- Defaults --------------------------------------------------------------

/**
 * Attaches a default value to something that generates postings.
 *
 * "This credit card belongs to the Airport site" said once, instead of on
 * every line of every statement.
 */
export async function setDimensionDefault(
  ctx: ActorContext,
  input: {
    ownerType: DefaultOwnerType
    ownerId: string
    dimensionId: string
    dimensionValueId: string
  },
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  await validateAssignment(ctx, { [input.dimensionId]: input.dimensionValueId }, db)

  await db
    .insert(dimensionDefaults)
    .values({
      companyId: ctx.companyId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      dimensionId: input.dimensionId,
      dimensionValueId: input.dimensionValueId,
      createdBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [
        dimensionDefaults.ownerType,
        dimensionDefaults.ownerId,
        dimensionDefaults.dimensionId,
      ],
      set: { dimensionValueId: input.dimensionValueId },
    })
}

export async function clearDimensionDefault(
  ctx: ActorContext,
  ownerType: DefaultOwnerType,
  ownerId: string,
  dimensionId: string,
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  await db
    .delete(dimensionDefaults)
    .where(
      scoped(
        ctx,
        dimensionDefaults,
        eq(dimensionDefaults.ownerType, ownerType),
        eq(dimensionDefaults.ownerId, ownerId),
        eq(dimensionDefaults.dimensionId, dimensionId),
      ),
    )
}

/**
 * Works out what a line's dimensions should be, given what was typed and what
 * the owners default to.
 *
 * Explicit beats default, and earlier owners beat later ones — so the caller
 * lists owners in order of specificity. A vendor's department beats the
 * company's, and a line somebody actually tagged beats both.
 *
 * The resolution happens at *posting* time and the result is stored on the
 * line. Resolving at read time would mean changing a default in June silently
 * restated January, and a report that moves under a prior print is a report
 * nobody can reconcile.
 */
export async function resolveDefaults(
  ctx: ActorContext,
  explicit: DimensionAssignment,
  owners: Array<{ ownerType: DefaultOwnerType; ownerId: string | null | undefined }>,
  exec: Executor = db,
): Promise<DimensionAssignment> {
  const candidates = owners.filter((owner) => Boolean(owner.ownerId))
  if (candidates.length === 0) return explicit

  const rows = await exec
    .select({
      ownerType: dimensionDefaults.ownerType,
      ownerId: dimensionDefaults.ownerId,
      dimensionId: dimensionDefaults.dimensionId,
      dimensionValueId: dimensionDefaults.dimensionValueId,
    })
    .from(dimensionDefaults)
    .where(
      scoped(
        ctx,
        dimensionDefaults,
        inArray(
          dimensionDefaults.ownerId,
          candidates.map((owner) => owner.ownerId as string),
        ),
      ),
    )

  const resolved: DimensionAssignment = { ...explicit }

  for (const owner of candidates) {
    for (const row of rows) {
      if (row.ownerType !== owner.ownerType || row.ownerId !== owner.ownerId) continue
      // `in` rather than a truthiness check: a dimension the caller explicitly
      // set is settled, and the first owner to answer for an unset one wins.
      if (row.dimensionId in resolved) continue
      resolved[row.dimensionId] = row.dimensionValueId
    }
  }

  return resolved
}

// --- Reclassification ------------------------------------------------------

export type UnassignedLine = {
  journalLineId: string
  entryId: string
  entryNumber: number
  entryDate: string
  accountId: string
  memo: string | null
  debitCents: number
  creditCents: number
}

/**
 * Posted profit-and-loss lines that carry no value for a dimension.
 *
 * This is the work list behind the coverage figure. Books get dimensionalized
 * after the fact far more often than they get set up correctly on day one —
 * somebody decides in March that they want to see the two sites separately,
 * and there are two months of history to catch up on.
 */
export async function unassignedLines(
  ctx: ActorContext,
  dimensionId: string,
  opts: { startDate?: string; endDate?: string; limit?: number } = {},
): Promise<UnassignedLine[]> {
  requirePermission(ctx, 'accounting:view')

  const conditions = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    sql`${journalLines.chartAccountId} IN (
      SELECT id FROM chart_accounts
       WHERE company_id = ${ctx.companyId}
         AND type IN ('revenue', 'cogs', 'expense', 'other_income', 'other_expense')
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM journal_line_dimensions d
       WHERE d.journal_line_id = ${journalLines.id}
         AND d.dimension_id = ${dimensionId}
    )`,
  ]

  if (opts.startDate) conditions.push(sql`${journalEntries.entryDate} >= ${opts.startDate}`)
  if (opts.endDate) conditions.push(sql`${journalEntries.entryDate} <= ${opts.endDate}`)

  return db
    .select({
      journalLineId: journalLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      accountId: journalLines.chartAccountId,
      memo: journalLines.memo,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNumber))
    .limit(opts.limit ?? 200)
}

/**
 * Assigns a dimension value to a batch of already-posted lines.
 *
 * ## This is not a journal entry, and does not pretend to be
 *
 * Reclassifying does not move a cent between accounts. No debit changes, no
 * credit changes, the trial balance is identical before and after — all that
 * changes is which column of a *dimensional* report the same money appears in.
 * So it writes to `journal_line_dimensions` and posts nothing, and it is
 * allowed inside a closed period for the same reason: nothing that a close
 * protects has moved.
 *
 * It is still audited, because "who decided this belonged to Downtown" is a
 * question somebody will ask.
 */
export async function reclassifyLines(
  ctx: ActorContext,
  input: { journalLineIds: string[]; dimensionId: string; dimensionValueId: string | null },
): Promise<number> {
  requirePermission(ctx, 'accounting:journal')

  if (input.journalLineIds.length === 0) return 0

  return db.transaction(async (tx) => {
    // Scoped, so an id from another tenant silently drops out rather than
    // being reclassified.
    const owned = await tx
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(scoped(ctx, journalLines, inArray(journalLines.id, input.journalLineIds)))

    if (owned.length === 0) return 0
    const ids = owned.map((row) => row.id)

    if (input.dimensionValueId === null) {
      const removed = await tx
        .delete(journalLineDimensions)
        .where(
          scoped(
            ctx,
            journalLineDimensions,
            inArray(journalLineDimensions.journalLineId, ids),
            eq(journalLineDimensions.dimensionId, input.dimensionId),
          ),
        )
        .returning({ id: journalLineDimensions.id })

      await recordAudit(
        ctx,
        {
          action: 'dimension.reclassify',
          entityType: 'dimension',
          entityId: input.dimensionId,
          after: { cleared: removed.length },
        },
        tx,
      )

      return removed.length
    }

    await validateAssignment(ctx, { [input.dimensionId]: input.dimensionValueId }, tx)

    await tx
      .insert(journalLineDimensions)
      .values(
        ids.map((journalLineId) => ({
          companyId: ctx.companyId,
          journalLineId,
          dimensionId: input.dimensionId,
          dimensionValueId: input.dimensionValueId as string,
        })),
      )
      .onConflictDoUpdate({
        target: [journalLineDimensions.journalLineId, journalLineDimensions.dimensionId],
        set: { dimensionValueId: input.dimensionValueId },
      })

    await recordAudit(
      ctx,
      {
        action: 'dimension.reclassify',
        entityType: 'dimension',
        entityId: input.dimensionId,
        after: { lines: ids.length, dimensionValueId: input.dimensionValueId },
      },
      tx,
    )

    return ids.length
  })
}

/** Uppercase, no spaces. `downtown site` → `DOWNTOWN_SITE`. */
function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
