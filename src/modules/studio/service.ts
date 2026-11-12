import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  brandKits,
  clauseVersions,
  clauses,
  companies,
  companyProfiles,
  serviceItems,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DomainError, Refusal } from '@/modules/errors'
import { BRAND_STYLE_FIELDS, brandStyleProblem } from '@/modules/design/style-values'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { missing } from '@/modules/errors/missing'

/**
 * The Design Center — "Company Studio" in spec §15.
 *
 * Profile, brand, reusable services, and approved legal language — the single
 * source these feed both the Proposal Designer and, in Phase 5, the Marketing
 * Creative Studio.
 */

// --- Profile ---------------------------------------------------------------

/**
 * What a company may say about itself.
 *
 * `addressLine2` and `country` joined this type in Phase 210, and the reason
 * they were missing is worth keeping. Phase 200 found that the Design Center's
 * form had no field for `description`, added one, and the test written for that
 * named two more columns `letterhead.ts` reads on every document a client sees.
 * All three got a **field**. None of them got a **place to land**: this type
 * never learned `addressLine2` or `country`, and `saveProfileAction`'s schema
 * learned none of the three — so a company could type its second address line,
 * press Save, read *"Company profile saved."* and have the value dropped by
 * `profileSchema.parse`, which strips what it does not declare.
 *
 * The tripwire Phase 200 left behind asserts the **form** covers the table, and
 * it passed throughout, because a form is one of the three places a field has
 * to exist. `tests/the-boxes-that-threw-it-away.test.ts` now asserts the chain.
 */
export type ProfileInput = {
  legalName?: string | null
  dba?: string | null
  tagline?: string | null
  description?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  phone?: string | null
  email?: string | null
  website?: string | null
  taxId?: string | null
  paymentInstructions?: string | null
  documentFooter?: string | null
}

/** The profile, or null when a company has not filled one in yet. */
export async function getProfile(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')

  const [profile] = await db
    .select()
    .from(companyProfiles)
    .where(scoped(ctx, companyProfiles))
    .limit(1)

  return profile ?? null
}

/** Creates or updates the profile. One row per company, so this upserts. */
export async function saveProfile(ctx: ActorContext, input: ProfileInput) {
  requirePermission(ctx, 'company:manage')

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.companyId, ctx.companyId))
      .limit(1)

    const [profile] = existing
      ? await tx
          .update(companyProfiles)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(companyProfiles.companyId, ctx.companyId))
          .returning()
      : await tx
          .insert(companyProfiles)
          .values({ companyId: ctx.companyId, ...input })
          .returning()

    await recordAudit(
      ctx,
      {
        action: 'profile.update',
        entityType: 'company_profile',
        entityId: profile.id,
        after: input as Record<string, unknown>,
      },
      tx,
    )

    return profile
  })
}

// --- Brand kits ------------------------------------------------------------

export type BrandKitInput = {
  name: string
  primaryColor?: string
  accentColor?: string
  textColor?: string
  mutedColor?: string
  surfaceColor?: string
  headingFont?: string
  bodyFont?: string
  baseSizePt?: number
  logoAssetId?: string | null
  isDefault?: boolean
}

/**
 * A brand value that may not be interpolated into a style attribute.
 *
 * A `DomainError` rather than a bare `Error`, since Phase 80. `messageFor`
 * denies by default — only a `DomainError` reaches the browser — so
 * `assertColors` threw `primaryColor must be a hex colour such as #0d6e60.`
 * and the Design Center put **"Something went wrong."** on screen. That
 * sentence had never once been read by the person it was written for; the
 * browser check for this phase is what found it.
 */
export class BrandValueError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'BrandValueError'
  }
}

/**
 * Refuses any brand value that must not be interpolated into a style attribute.
 *
 * The rule itself is in `modules/design/style-values`, and covers the two font
 * fields as well as the five colours since Phase 80 — they land in the same
 * attribute and had no rule at all, so `bodyFont` accepted any two hundred
 * characters a caller sent. This function is the enforcement; the guarantee is
 * that both write paths call it, which `tests/brand-style.test.ts` asserts.
 */
function assertBrandStyle(input: Partial<BrandKitInput>) {
  for (const field of BRAND_STYLE_FIELDS) {
    const value = input[field.key]
    if (value === undefined) continue

    const problem = brandStyleProblem(field, value)
    if (problem) throw new BrandValueError(problem)
  }
}

export async function createBrandKit(ctx: ActorContext, input: BrandKitInput) {
  requirePermission(ctx, 'company:manage')
  assertBrandStyle(input)

  return db.transaction(async (tx) => {
    if (input.isDefault) await clearDefaultKit(ctx, tx)

    const [kit] = await tx
      .insert(brandKits)
      .values({ companyId: ctx.companyId, ...input })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'brand_kit.create',
        entityType: 'brand_kit',
        entityId: kit.id,
        after: { name: kit.name, primaryColor: kit.primaryColor },
      },
      tx,
    )

    return kit
  })
}

export async function updateBrandKit(
  ctx: ActorContext,
  kitId: string,
  input: Partial<BrandKitInput>,
) {
  requirePermission(ctx, 'company:manage')
  assertBrandStyle(input)

  return db.transaction(async (tx) => {
    if (input.isDefault) await clearDefaultKit(ctx, tx)

    const [kit] = await tx
      .update(brandKits)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(brandKits.id, kitId), eq(brandKits.companyId, ctx.companyId)))
      .returning()

    if (!kit) throw missing('brandKit')

    await recordAudit(
      ctx,
      {
        action: 'brand_kit.update',
        entityType: 'brand_kit',
        entityId: kitId,
        after: input as Record<string, unknown>,
      },
      tx,
    )

    return kit
  })
}

async function clearDefaultKit(ctx: ActorContext, tx: Executor) {
  await tx
    .update(brandKits)
    .set({ isDefault: false })
    .where(eq(brandKits.companyId, ctx.companyId))
}

export async function listBrandKits(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(brandKits)
    .where(scoped(ctx, brandKits))
    .orderBy(desc(brandKits.isDefault), asc(brandKits.name))
}

/**
 * The kit documents use when none is chosen.
 *
 * Falls back to any kit rather than nothing, so a company that created one
 * without marking it default still gets branded output.
 */
export async function defaultBrandKit(companyId: string, exec: Executor = db) {
  const rows = await exec
    .select()
    .from(brandKits)
    .where(eq(brandKits.companyId, companyId))
    .orderBy(desc(brandKits.isDefault), asc(brandKits.createdAt))
    .limit(1)

  return rows[0] ?? null
}

/**
 * Installs a starter brand kit and profile for a new company.
 *
 * Called from onboarding so the first proposal is branded rather than blank.
 */
export async function installStudioDefaults(
  companyId: string,
  companyName: string,
  exec: Executor = db,
) {
  await exec
    .insert(companyProfiles)
    .values({ companyId, legalName: companyName })
    .onConflictDoNothing()

  const existing = await exec
    .select({ id: brandKits.id })
    .from(brandKits)
    .where(eq(brandKits.companyId, companyId))
    .limit(1)

  if (existing.length > 0) return

  await exec.insert(brandKits).values({
    companyId,
    name: 'Default',
    isDefault: true,
  })
}

// --- Service catalog -------------------------------------------------------

export type ServiceItemInput = {
  name: string
  code?: string | null
  description?: string | null
  unit?: string
  unitPriceCents?: number
  unitCostCents?: number
  isTaxable?: boolean
  chartAccountId?: string | null
  defaultProposalCopy?: string | null
}

export async function createServiceItem(ctx: ActorContext, input: ServiceItemInput) {
  requirePermission(ctx, 'company:manage')

  const [item] = await db
    .insert(serviceItems)
    .values({ companyId: ctx.companyId, ...input })
    .returning()

  await recordAudit(ctx, {
    action: 'service_item.create',
    entityType: 'service_item',
    entityId: item.id,
    after: { name: item.name, unitPriceCents: item.unitPriceCents },
  })

  return item
}

/**
 * The service catalogue, live items only unless asked otherwise (Phase 206).
 *
 * The option was `activeOnly`, **opt-in**, which is the unsafe default: a
 * caller who forgot it offered retired items. Measured before changing, which
 * is the only reason this is a tidy-up rather than a fix — **all three screens
 * that offer items already passed the flag**, and the Studio did not because
 * it is the library. So flipping the sense changes no behaviour and removes
 * the trap, and the three call sites that passed `activeOnly: true` now pass
 * nothing.
 *
 * This is `listClauses`' and `listTeamMembers`' shape, so the three list
 * functions in this module agree. ADR 0205 declined exactly this change on
 * the grounds that it was *"a behaviour change in five screens"* — four
 * callers, and no behaviour change, both of which measuring settled.
 *
 * It is **not** the last one, which is the other thing that measurement
 * found. Six more list functions still take `activeOnly` opt-in —
 * `listAccounts`, `listFinancialAccounts`, `listEmployees`, `listTaxCodes`,
 * `listCostCodes` and `subcontractorSummaries` — and `listAccounts` had four
 * callers feeding a picker with no flag at all. Those four are fixed in Phase
 * 206; the remaining five functions are nominated, because telling an offer
 * from a list needs each caller read.
 */
export async function listServiceItems(
  ctx: ActorContext,
  opts: { includeRetired?: boolean } = {},
) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(serviceItems)
    .where(
      scoped(ctx, serviceItems, opts.includeRetired ? undefined : eq(serviceItems.isActive, true)),
    )
    .orderBy(asc(serviceItems.name))
}

/**
 * Takes a catalogue item out of the pickers, or puts it back (Phase 206).
 *
 * ## A retirement with no way back
 *
 * `deactivateServiceItem` has existed since Phase 4 and set `isActive` to
 * **false only**. Nothing anywhere set it true, so an item retired by mistake
 * — or a service a business started offering again — was gone from every
 * picker for ever. That is a delete wearing a flag, and it is the mirror of
 * the six switches Phases 202–205 closed: not a column with no writer, but a
 * column with a writer in one direction.
 *
 * It also wrote no audit event, which made it the only one of the Studio's
 * four libraries whose retirement left no trace: brand kits, clauses and team
 * members all record both directions.
 *
 * ## What measuring the nominated gap found instead
 *
 * ADR 0205 nominated this area for a different reason — `listServiceItems`
 * takes `activeOnly` **opt-in**, which is the unsafe default, and the question
 * was *which screens are offering retired items today*. Measured, the answer
 * is **none**: all three screens that offer items pass the flag, and the
 * Studio deliberately does not because it is the library. The latent trap is
 * real and the live defect was not there.
 *
 * That ADR also gave a reason for declining to change the default — *"a
 * behaviour change in five screens dressed as a tidy-up"* — and both halves
 * were wrong. There are four callers, not five, and since every offer-site
 * already passes the flag, flipping the default to `includeRetired` changes
 * no behaviour at all. Phase 206 does it, which is what the measurement
 * licensed.
 *
 * ## Retiring an item that still holds stock is allowed
 *
 * The other half of the nomination feared that retiring an inventoried item
 * with a quantity on it would hide a balance the subledger carries and the
 * Inventory account agrees with. It does not: `stockOnHand` filters on
 * `isInventoried` and **not** on `isActive`, so a retired item keeps its lots,
 * its value and its line in the reconciliation. Stopping it being sold is a
 * different act from writing off what is left, which is Phase 203's
 * distinction and it already holds here.
 */
export async function setServiceItemActive(
  ctx: ActorContext,
  input: { itemId: string; isActive: boolean },
) {
  requirePermission(ctx, 'company:manage')

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: serviceItems.id, name: serviceItems.name, isActive: serviceItems.isActive })
      .from(serviceItems)
      .where(scoped(ctx, serviceItems, eq(serviceItems.id, input.itemId)))
      .limit(1)

    if (!before) throw new Refusal('That item is not in this catalogue.')

    const [row] = await tx
      .update(serviceItems)
      .set({ isActive: input.isActive })
      .where(scoped(ctx, serviceItems, eq(serviceItems.id, input.itemId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: input.isActive ? 'service_item.restore' : 'service_item.retire',
        entityType: 'service_item',
        entityId: row.id,
        before: { isActive: before.isActive },
        after: { isActive: row.isActive, name: row.name },
      },
      tx,
    )

    return row
  })
}

/**
 * Retires an item. Kept as the name four phases of callers already use.
 *
 * A thin call through to `setServiceItemActive` rather than a second
 * implementation — two answers to one question is the defect, and the one
 * thing this signature cannot express is putting an item back.
 */
export async function deactivateServiceItem(ctx: ActorContext, itemId: string) {
  await setServiceItemActive(ctx, { itemId, isActive: false })
}

// --- Clause library --------------------------------------------------------

/**
 * Creates a clause with its first version (spec §7, §15).
 *
 * The clause is the stable identity and the wording lives in versions, so a
 * proposal already sent keeps the language it was sent with when the company
 * later revises its standard terms.
 */
export async function createClause(
  ctx: ActorContext,
  input: { title: string; category?: string; body: string; approve?: boolean },
) {
  requirePermission(ctx, 'company:manage')

  return db.transaction(async (tx) => {
    const [clause] = await tx
      .insert(clauses)
      .values({
        companyId: ctx.companyId,
        title: input.title,
        category: input.category ?? 'terms',
      })
      .returning()

    const [version] = await tx
      .insert(clauseVersions)
      .values({
        companyId: ctx.companyId,
        clauseId: clause.id,
        versionNumber: 1,
        body: input.body,
        approvedAt: input.approve ? new Date() : null,
        approvedBy: input.approve ? ctx.userId : null,
        createdBy: ctx.userId,
      })
      .returning()

    await tx
      .update(clauses)
      .set({ currentVersionId: version.id })
      .where(eq(clauses.id, clause.id))

    await recordAudit(
      ctx,
      {
        action: 'clause.create',
        entityType: 'clause',
        entityId: clause.id,
        after: { title: clause.title, category: clause.category, approved: Boolean(input.approve) },
      },
      tx,
    )

    return { clause, version }
  })
}

/** Adds a new version. Documents already referencing an older one keep it. */
export async function reviseClause(
  ctx: ActorContext,
  clauseId: string,
  input: { body: string; approve?: boolean },
) {
  requirePermission(ctx, 'company:manage')

  return db.transaction(async (tx) => {
    const [clause] = await tx
      .select()
      .from(clauses)
      .where(and(eq(clauses.id, clauseId), eq(clauses.companyId, ctx.companyId)))
      .limit(1)

    if (!clause) throw missing('clause')

    const [{ nextVersion }] = await tx
      .select({
        nextVersion: sql<number>`coalesce(max(${clauseVersions.versionNumber}), 0) + 1`,
      })
      .from(clauseVersions)
      .where(eq(clauseVersions.clauseId, clauseId))

    const [version] = await tx
      .insert(clauseVersions)
      .values({
        companyId: ctx.companyId,
        clauseId,
        versionNumber: nextVersion,
        body: input.body,
        approvedAt: input.approve ? new Date() : null,
        approvedBy: input.approve ? ctx.userId : null,
        createdBy: ctx.userId,
      })
      .returning()

    await tx
      .update(clauses)
      .set({ currentVersionId: version.id })
      .where(eq(clauses.id, clauseId))

    await recordAudit(
      ctx,
      {
        action: 'clause.revise',
        entityType: 'clause',
        entityId: clauseId,
        after: { versionNumber: nextVersion, approved: Boolean(input.approve) },
      },
      tx,
    )

    return version
  })
}

/** Clauses with their current wording, for the designer's insert menu. */
/**
 * The clause library (spec §7, §15), live clauses only unless asked otherwise.
 *
 * ## Why the default is the safe one, against this file's own precedent
 *
 * `clauses.isActive` was one of the two **projection-only** switches Phase 202
 * found: selected here to be displayed and filtered by nothing, so a retired
 * clause went on appearing in the picker on every new proposal. That is how
 * superseded language gets sent, and it is why ADR 0204 nominated these two
 * *filter first* — a writer with no filter is a control that does nothing.
 *
 * `includeRetired`, opt-out, which is `listTeamMembers`' shape in this same
 * module rather than `listServiceItems`' `activeOnly` opt-in — and the Studio
 * page already passes `{ includeRetired: true }` for team members under a
 * comment saying it is *"the one screen that can restore them"*. That is the
 * nearer precedent and the right one here for the same reason: three screens
 * read this list, two of them to **offer** clauses for a document and one to
 * manage them, and a caller who forgets the flag should get the safe answer.
 * For an offer the safe answer is "only what is still approved", so a picker
 * added in two years gets it without knowing this sentence exists.
 *
 * `listServiceItems` is the odd one out of the three and is left alone: its
 * callers were written against an opt-in flag, and changing it is a behaviour
 * change in five screens dressed as a tidy-up.
 *
 * ## Why retiring one cannot touch a document, sent or draft
 *
 * A document block stores `clauseVersionId`, not a clause id — *"what a client
 * was shown must not"* change, in `blocks.ts`'s own words. So the wording on
 * every proposal ever sent is reached through the version, and retiring the
 * clause is invisible to all of them. ADR 0021 is satisfied by the schema
 * rather than by a rule here, which is why this phase's filter belongs on the
 * **offer** and nowhere near a document.
 */
export async function listClauses(ctx: ActorContext, opts: { includeRetired?: boolean } = {}) {
  requirePermission(ctx, 'crm:view')

  return db
    .select({
      id: clauses.id,
      title: clauses.title,
      category: clauses.category,
      isActive: clauses.isActive,
      currentVersionId: clauses.currentVersionId,
      body: clauseVersions.body,
      versionNumber: clauseVersions.versionNumber,
      approvedAt: clauseVersions.approvedAt,
    })
    .from(clauses)
    .leftJoin(clauseVersions, eq(clauseVersions.id, clauses.currentVersionId))
    .where(scoped(ctx, clauses, opts.includeRetired ? undefined : eq(clauses.isActive, true)))
    .orderBy(asc(clauses.category), asc(clauses.title))
}

/**
 * Takes a clause out of the library, or puts it back (Phase 205).
 *
 * The writer the column never had. Not a revision: `reviseClause` gives new
 * language to the same clause and every document keeps the version it was
 * sent with, while this stops the clause being **offered** without touching a
 * word of any version.
 *
 * No refusal to make. A clause is *copied* into a document as a version id at
 * the moment somebody adds it, so there is no later moment at which a retired
 * clause could be acted on — unlike a bill of materials, which a work order
 * goes on referencing for the life of the run and which therefore needs
 * `createWorkOrder` to refuse one. The difference is copying against
 * referencing, and it is why these two switches are closed in one phase and
 * not with one mechanism.
 */
export async function setClauseActive(
  ctx: ActorContext,
  input: { clauseId: string; isActive: boolean },
) {
  requirePermission(ctx, 'company:manage')

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: clauses.id, title: clauses.title, isActive: clauses.isActive })
      .from(clauses)
      .where(scoped(ctx, clauses, eq(clauses.id, input.clauseId)))
      .limit(1)

    if (!before) throw new Refusal('That clause is not in this library.')

    const [row] = await tx
      .update(clauses)
      .set({ isActive: input.isActive })
      .where(scoped(ctx, clauses, eq(clauses.id, input.clauseId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: input.isActive ? 'clause.restore' : 'clause.retire',
        entityType: 'clause',
        entityId: row.id,
        before: { isActive: before.isActive },
        after: { isActive: row.isActive, title: row.title },
      },
      tx,
    )

    return row
  })
}

/** One clause version, scoped to the tenant. */
export async function clauseVersion(ctx: ActorContext, versionId: string) {
  const [version] = await db
    .select()
    .from(clauseVersions)
    .where(scoped(ctx, clauseVersions, eq(clauseVersions.id, versionId)))
    .limit(1)

  return version ?? null
}

/** Company display name, preferring the profile's legal name. */
export async function companyDisplayName(companyId: string): Promise<string> {
  const [row] = await db
    .select({ name: companies.name, legalName: companyProfiles.legalName })
    .from(companies)
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
    .where(eq(companies.id, companyId))
    .limit(1)

  return row?.legalName || row?.name || 'Company'
}
