import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  companies,
  companyProfiles,
  contacts,
  designDocuments,
  documentTemplates,
  opportunities,
  organizations,
  projects,
  proposalItems,
  proposals,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import type { Permission } from '@/modules/permissions'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { defaultBrandKit } from '@/modules/studio/service'
import { letterheadFor } from '@/modules/brand/letterhead'
import { parseBlocks, validateBlocks, type Block } from './blocks'
import { buildMergeContext, type MergeContext } from './merge-fields'
import { builtInTemplate, templatesForIndustry, type TemplateDefinition } from './templates'
import { missing } from '@/modules/errors/missing'

/**
 * Design document persistence and composition (spec §7).
 *
 * The document is generic — see `schema/design.ts`. This module is where a
 * proposal *acquires* one, and where the data a proposal knows about (its line
 * items, its client) is assembled into the merge context the renderer needs.
 */

/** Fresh block ids, so copying a template never collides with a live document. */
export function withFreshIds(blocks: Block[]): Block[] {
  return blocks.map((block) => ({ ...block, id: randomUUID() }))
}

/**
 * The document for a proposal, creating one from a template on first use.
 *
 * A proposal created before Phase 4, or created through the API without
 * choosing a template, still needs something to render — so this falls back to
 * the standard template rather than returning nothing.
 */
export async function documentForProposal(
  ctx: ActorContext,
  proposalId: string,
  opts: { templateKey?: string } = {},
) {
  requirePermission(ctx, 'proposals:view')

  const [existing] = await db
    .select()
    .from(designDocuments)
    .where(scoped(ctx, designDocuments, eq(designDocuments.proposalId, proposalId)))
    .limit(1)

  if (existing) return existing

  return createDocumentForProposal(ctx, proposalId, opts.templateKey ?? 'standard-services')
}

export async function createDocumentForProposal(
  ctx: ActorContext,
  proposalId: string,
  templateKey: string,
) {
  requirePermission(ctx, 'proposals:manage')

  const [proposal] = await db
    .select()
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))
    .limit(1)

  if (!proposal) throw missing('proposal')

  const blocks = await resolveTemplateBlocks(ctx, templateKey)
  const brandKit = await defaultBrandKit(ctx.companyId)

  return db.transaction(async (tx) => {
    const [document] = await tx
      .insert(designDocuments)
      .values({
        companyId: ctx.companyId,
        kind: 'proposal',
        name: proposal.title,
        proposalId,
        brandKitId: brandKit?.id ?? null,
        blocks: withFreshIds(blocks),
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'document.create',
        entityType: 'design_document',
        entityId: document.id,
        after: { proposalId, templateKey, blockCount: blocks.length },
      },
      tx,
    )

    return document
  })
}

/** Blocks for a template key, from the company's library or the built-ins. */
async function resolveTemplateBlocks(ctx: ActorContext, templateKey: string): Promise<Block[]> {
  const [saved] = await db
    .select()
    .from(documentTemplates)
    .where(
      and(
        eq(documentTemplates.key, templateKey),
        eq(documentTemplates.companyId, ctx.companyId),
      ),
    )
    .limit(1)

  if (saved) return parseBlocks(saved.blocks)

  const builtIn = builtInTemplate(templateKey)
  if (builtIn) return builtIn.blocks

  // An unknown key should not produce an empty proposal.
  return builtInTemplate('standard-services')?.blocks ?? []
}

/** Replaces a document's blocks with a template's, discarding current content. */
export async function applyTemplate(ctx: ActorContext, documentId: string, templateKey: string) {
  const document = await loadDocument(ctx, documentId)
  requirePermission(ctx, permissionFor(document.kind, 'manage'))

  const blocks = await resolveTemplateBlocks(ctx, templateKey)

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(designDocuments)
      .set({ blocks: withFreshIds(blocks), updatedAt: new Date() })
      .where(
        and(eq(designDocuments.id, documentId), eq(designDocuments.companyId, ctx.companyId)),
      )
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'document.apply_template',
        entityType: 'design_document',
        entityId: documentId,
        before: { blockCount: parseBlocks(document.blocks).length },
        after: { templateKey, blockCount: blocks.length },
      },
      tx,
    )

    return updated
  })
}

export type DocumentSettings = {
  name?: string
  brandKitId?: string | null
  pageSize?: 'letter' | 'a4' | 'legal'
  orientation?: 'portrait' | 'landscape'
  headerText?: string | null
  footerText?: string | null
  showPageNumbers?: boolean
}

/**
 * Saves the block list and page settings.
 *
 * Malformed blocks are rejected outright here rather than dropped: on the save
 * path a silent loss of the user's work would be far worse than an error
 * message. The read path is forgiving instead — see `parseBlocks`.
 */
export async function saveDocument(
  ctx: ActorContext,
  documentId: string,
  input: { blocks?: unknown; settings?: DocumentSettings },
) {
  // The document is loaded first because which permission applies depends on
  // what it is for — see `permissionFor`. Tenant isolation is not at stake:
  // `loadDocument` is scoped, so another company's document is simply absent.
  const document = await loadDocument(ctx, documentId)
  requirePermission(ctx, permissionFor(document.kind, 'manage'))

  let blocks: Block[] | undefined
  if (input.blocks !== undefined) {
    const result = validateBlocks(input.blocks)
    if (result.errors.length > 0) {
      throw new Error(`Could not save the document — ${result.errors[0]}`)
    }
    blocks = result.blocks
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(designDocuments)
      .set({
        ...(blocks ? { blocks } : {}),
        ...(input.settings ?? {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(designDocuments.id, documentId), eq(designDocuments.companyId, ctx.companyId)),
      )
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'document.update',
        entityType: 'design_document',
        entityId: documentId,
        before: { blockCount: parseBlocks(document.blocks).length },
        after: { blockCount: blocks?.length ?? parseBlocks(document.blocks).length },
      },
      tx,
    )

    return updated
  })
}

async function loadDocument(ctx: ActorContext, documentId: string) {
  const [document] = await db
    .select()
    .from(designDocuments)
    .where(scoped(ctx, designDocuments, eq(designDocuments.id, documentId)))
    .limit(1)

  if (!document) throw missing('document')
  return document
}

export async function getDocument(ctx: ActorContext, documentId: string) {
  const document = await loadDocument(ctx, documentId)
  requirePermission(ctx, permissionFor(document.kind, 'view'))
  return document
}

/**
 * Which permission governs a document (spec §14).
 *
 * A marketing role has no proposal permissions and a sales role has no
 * marketing ones, yet both edit documents through the same engine. The
 * document's own `kind` decides which check applies, so neither role gains
 * reach into the other's work by way of a shared editor.
 */
function permissionFor(kind: string, level: 'view' | 'manage'): Permission {
  return kind === 'marketing' ? `marketing:${level}` : `proposals:${level}`
}

/** Saves the current document as a reusable company template (spec §7). */
export async function saveAsTemplate(
  ctx: ActorContext,
  documentId: string,
  input: { key: string; name: string; description?: string },
) {
  requirePermission(ctx, 'proposals:manage')

  const document = await loadDocument(ctx, documentId)

  return db.transaction(async (tx) => {
    const [template] = await tx
      .insert(documentTemplates)
      .values({
        companyId: ctx.companyId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        kind: document.kind,
        blocks: document.blocks,
        createdBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [documentTemplates.companyId, documentTemplates.key],
        set: { name: input.name, blocks: document.blocks },
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'template.save',
        entityType: 'document_template',
        entityId: template.id,
        after: { key: template.key, name: template.name },
      },
      tx,
    )

    return template
  })
}

/**
 * The gallery: built-in templates ordered for this company's industry, plus
 * anything the company has saved.
 */
export async function listTemplates(ctx: ActorContext): Promise<
  Array<TemplateDefinition & { source: 'built-in' | 'company' }>
> {
  // Templates are shared company property, not proposal data — the marketing
  // designer offers the same gallery. `crm:view` is what both roles hold.
  requirePermission(ctx, 'crm:view')

  const [company] = await db
    .select({ industry: companies.industry })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1)

  const saved = await db
    .select()
    .from(documentTemplates)
    .where(
      and(
        eq(documentTemplates.kind, 'proposal'),
        or(eq(documentTemplates.companyId, ctx.companyId), isNull(documentTemplates.companyId)),
      ),
    )
    .orderBy(asc(documentTemplates.name))

  const companyTemplates = saved
    .filter((template) => template.companyId === ctx.companyId)
    .map((template) => ({
      key: template.key,
      name: template.name,
      description: template.description ?? '',
      kind: 'proposal' as const,
      industry: template.industry,
      blocks: parseBlocks(template.blocks),
      source: 'company' as const,
    }))

  const builtIns = templatesForIndustry(company?.industry ?? null).map((template) => ({
    ...template,
    source: 'built-in' as const,
  }))

  return [...companyTemplates, ...builtIns]
}

/**
 * Assembles everything the renderer needs for a proposal document.
 *
 * Returns the merge context, the line items the fee table draws, and the brand
 * kit — gathered here so both the authenticated preview and the public
 * client-facing page render from exactly the same inputs.
 */
/**
 * The merge context for a document with no client attached (spec §8).
 *
 * Marketing creative is written once and sent to many people, so at design
 * time there is no single client to merge in. The company fields resolve; the
 * client fields are filled with a visible sample so the author can see where
 * a name will land instead of editing around blanks. The real values are
 * substituted per recipient at send time.
 */
export async function marketingRenderContext(companyId: string): Promise<MergeContext> {
  const [row] = await db
    .select({ company: companies, profile: companyProfiles })
    .from(companies)
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
    .where(eq(companies.id, companyId))
    .limit(1)

  // A company that does not exist has no fields to merge. Previously this
  // returned a context of empty strings, which renders as a creative addressed
  // from nobody rather than as the missing company it is.
  if (!row) return buildMergeContext({})

  // `?? row.company.name` used to be the answer here, and `|| row.company.name`
  // thirty lines below in `proposalRenderContext`. One character apart, and with
  // a legal name cleared to `''` (ADR 0074) the proposal was right and this
  // preview showed a company with no name. One answer now, for both. Phase 75.
  const head = letterheadFor({ companyName: row.company.name, profile: row.profile })

  return buildMergeContext({
    company: head,
    client: {
      name: 'Sample Client Ltd',
      contactName: 'Sample Contact',
      email: 'contact@example.com',
    },
  })
}

export async function proposalRenderContext(
  companyId: string,
  proposalId: string,
  exec: Executor = db,
): Promise<{
  context: MergeContext
  items: Array<typeof proposalItems.$inferSelect>
  brandKitId: string | null
} | null> {
  const [row] = await exec
    .select({
      proposal: proposals,
      organization: organizations,
      company: companies,
      profile: companyProfiles,
      contact: contacts,
      project: projects,
    })
    .from(proposals)
    .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .innerJoin(companies, eq(companies.id, proposals.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, proposals.companyId))
    .leftJoin(contacts, eq(contacts.id, opportunities.primaryContactId))
    .leftJoin(projects, eq(projects.id, opportunities.convertedProjectId))
    .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, companyId)))
    .limit(1)

  if (!row) return null

  const items = await exec
    .select()
    .from(proposalItems)
    .where(eq(proposalItems.proposalId, proposalId))
    .orderBy(asc(proposalItems.sortOrder))

  const [document] = await exec
    .select({ brandKitId: designDocuments.brandKitId })
    .from(designDocuments)
    .where(eq(designDocuments.proposalId, proposalId))
    .limit(1)

  const contactName = [row.contact?.firstName, row.contact?.lastName].filter(Boolean).join(' ')

  const head = letterheadFor({ companyName: row.company.name, profile: row.profile })

  const context = buildMergeContext({
    company: { ...head, paymentInstructions: row.profile?.paymentInstructions },
    client: {
      name: row.organization.name,
      contactName: contactName || null,
      email: row.contact?.email ?? row.organization.email,
      addressLine1: row.organization.addressLine1,
      city: row.organization.city,
      region: row.organization.region,
      postalCode: row.organization.postalCode,
    },
    proposal: {
      number: row.proposal.number,
      title: row.proposal.title,
      totalCents: row.proposal.totalCents,
      subtotalCents: row.proposal.subtotalCents,
      issuedOn: (row.proposal.sentAt ?? row.proposal.createdAt).toISOString().slice(0, 10),
      expiresOn: row.proposal.expiresOn,
    },
    project: { code: row.project?.code, name: row.project?.name },
  })

  return { context, items, brandKitId: document?.brandKitId ?? null }
}

/** Documents for the company, filtered to one kind. */
export async function listDocuments(ctx: ActorContext, kind?: 'proposal' | 'marketing') {
  requirePermission(ctx, permissionFor(kind ?? 'proposal', 'view'))

  return db
    .select()
    .from(designDocuments)
    .where(scoped(ctx, designDocuments, kind ? eq(designDocuments.kind, kind) : undefined))
    .orderBy(desc(designDocuments.updatedAt))
}

/**
 * Creates a piece of marketing creative (spec §8).
 *
 * The counterpart to `createDocumentForProposal`, and deliberately the same
 * shape: same table, same templates, same brand kit. Nothing about a marketing
 * document is a different kind of object — it just has no proposal attached.
 */
export async function createMarketingDocument(
  ctx: ActorContext,
  input: { name: string; templateKey?: string },
) {
  requirePermission(ctx, 'marketing:manage')

  const blocks = input.templateKey ? await resolveTemplateBlocks(ctx, input.templateKey) : []
  const brandKit = await defaultBrandKit(ctx.companyId)

  return db.transaction(async (tx) => {
    const [document] = await tx
      .insert(designDocuments)
      .values({
        companyId: ctx.companyId,
        kind: 'marketing',
        name: input.name,
        brandKitId: brandKit?.id ?? null,
        blocks: withFreshIds(blocks),
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'document.create',
        entityType: 'design_document',
        entityId: document.id,
        after: { kind: 'marketing', name: input.name, blockCount: blocks.length },
      },
      tx,
    )

    return document
  })
}

/**
 * Copies a piece of creative (spec §8 "creative reuse").
 *
 * Block ids are regenerated so the copy and the original can be edited
 * independently — without that, the designer's selection state would follow
 * whichever document was opened last.
 */
export async function duplicateDocument(ctx: ActorContext, documentId: string, name?: string) {
  const source = await loadDocument(ctx, documentId)
  requirePermission(ctx, permissionFor(source.kind, 'manage'))

  return db.transaction(async (tx) => {
    const [copy] = await tx
      .insert(designDocuments)
      .values({
        companyId: ctx.companyId,
        // A copy is never attached to the original's proposal: it is a starting
        // point, not a second version of a document a client may be reading.
        kind: source.kind === 'proposal' ? 'marketing' : source.kind,
        name: name?.trim() || `${source.name} (copy)`,
        brandKitId: source.brandKitId,
        pageSize: source.pageSize,
        orientation: source.orientation,
        headerText: source.headerText,
        footerText: source.footerText,
        blocks: withFreshIds(parseBlocks(source.blocks)),
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'document.create',
        entityType: 'design_document',
        entityId: copy.id,
        after: { copiedFrom: documentId, name: copy.name },
      },
      tx,
    )

    return copy
  })
}
