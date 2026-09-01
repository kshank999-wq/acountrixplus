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
import { DomainError } from '@/modules/errors'
import { BRAND_STYLE_FIELDS, brandStyleProblem } from '@/modules/design/style-values'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'

/**
 * The Design Center — "Company Studio" in spec §15.
 *
 * Profile, brand, reusable services, and approved legal language — the single
 * source these feed both the Proposal Designer and, in Phase 5, the Marketing
 * Creative Studio.
 */

// --- Profile ---------------------------------------------------------------

export type ProfileInput = {
  legalName?: string | null
  dba?: string | null
  tagline?: string | null
  description?: string | null
  addressLine1?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
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

    if (!kit) throw new Error('Brand kit not found')

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

export async function listServiceItems(ctx: ActorContext, opts: { activeOnly?: boolean } = {}) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(serviceItems)
    .where(
      scoped(ctx, serviceItems, opts.activeOnly ? eq(serviceItems.isActive, true) : undefined),
    )
    .orderBy(asc(serviceItems.name))
}

export async function deactivateServiceItem(ctx: ActorContext, itemId: string) {
  requirePermission(ctx, 'company:manage')

  await db
    .update(serviceItems)
    .set({ isActive: false })
    .where(and(eq(serviceItems.id, itemId), eq(serviceItems.companyId, ctx.companyId)))
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

    if (!clause) throw new Error('Clause not found')

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
export async function listClauses(ctx: ActorContext) {
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
    .where(scoped(ctx, clauses))
    .orderBy(asc(clauses.category), asc(clauses.title))
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
