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
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { defaultBrandKit } from '@/modules/studio/service'
import { parseBlocks, validateBlocks, type Block } from './blocks'
import { buildMergeContext, type MergeContext } from './merge-fields'
import { builtInTemplate, templatesForIndustry, type TemplateDefinition } from './templates'

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

  if (!proposal) throw new Error('Proposal not found')

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
  requirePermission(ctx, 'proposals:manage')

  const document = await loadDocument(ctx, documentId)
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
  requirePermission(ctx, 'proposals:manage')

  const document = await loadDocument(ctx, documentId)

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

  if (!document) throw new Error('Document not found')
  return document
}

export async function getDocument(ctx: ActorContext, documentId: string) {
  requirePermission(ctx, 'proposals:view')
  return loadDocument(ctx, documentId)
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
  requirePermission(ctx, 'proposals:view')

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

  const context = buildMergeContext({
    company: {
      name: row.profile?.legalName || row.company.name,
      legalName: row.profile?.legalName,
      email: row.profile?.email,
      phone: row.profile?.phone,
      website: row.profile?.website,
      addressLine1: row.profile?.addressLine1,
      city: row.profile?.city,
      region: row.profile?.region,
      postalCode: row.profile?.postalCode,
      paymentInstructions: row.profile?.paymentInstructions,
    },
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

/** Documents for the company, for a future marketing asset list. */
export async function listDocuments(ctx: ActorContext, kind?: 'proposal' | 'marketing') {
  requirePermission(ctx, 'proposals:view')

  return db
    .select()
    .from(designDocuments)
    .where(scoped(ctx, designDocuments, kind ? eq(designDocuments.kind, kind) : undefined))
    .orderBy(desc(designDocuments.updatedAt))
}
