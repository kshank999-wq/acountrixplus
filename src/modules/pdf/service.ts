import { and, asc, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  brandKits,
  companies,
  designDocuments,
  proposals,
  proposalVersions,
} from '@/db/schema'
import { parseBlocks } from '@/modules/design/blocks'
import { proposalRenderContext } from '@/modules/design/documents'
import { storeDocument, attachDocument } from '@/modules/evidence/service'
import { scoped, requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { renderDocumentPdf, type BrandTokens, type RenderInput } from './layout'
import { DomainError } from '@/modules/errors'

/**
 * Rendering the documents this application already knows how to display
 * (spec §18 "server-side PDF generation and immutable proposal-version
 * snapshots", §7 "PDF export … version history, and PDF download").
 *
 * The rendering itself is pure — `layout.ts` takes data and returns bytes. This
 * file is the part that reads the database, and it exists so that nothing in
 * `src/app/` has to assemble a render input by hand and get the brand kit or the
 * line items subtly wrong.
 */

const DEFAULT_BRAND: BrandTokens = {
  primaryColor: '#0d6e60',
  accentColor: '#0f766e',
  textColor: '#0f172a',
  mutedColor: '#64748b',
  headingFont: 'Georgia, serif',
  bodyFont: 'system-ui, sans-serif',
  baseSizePt: 11,
}

async function brandFor(
  companyId: string,
  brandKitId: string | null,
  exec: Executor,
): Promise<BrandTokens> {
  const [kit] = brandKitId
    ? await exec
        .select()
        .from(brandKits)
        .where(and(eq(brandKits.id, brandKitId), eq(brandKits.companyId, companyId)))
        .limit(1)
    : await exec
        .select()
        .from(brandKits)
        .where(and(eq(brandKits.companyId, companyId), eq(brandKits.isDefault, true)))
        .limit(1)

  if (!kit) return DEFAULT_BRAND

  return {
    primaryColor: kit.primaryColor,
    accentColor: kit.accentColor,
    textColor: kit.textColor,
    mutedColor: kit.mutedColor,
    headingFont: kit.headingFont,
    bodyFont: kit.bodyFont,
    baseSizePt: kit.baseSizePt,
  }
}

export class NoDocumentError extends DomainError {
  readonly status = 404
  constructor() {
    super('That proposal has no document to render yet.')
    this.name = 'NoDocumentError'
  }
}

/**
 * Everything the renderer needs for one proposal, gathered under a tenant
 * filter.
 *
 * `createdAt` is a parameter rather than a default, all the way down. It is the
 * one decision that keeps the output reproducible: a default would be taken by
 * accident exactly once, and the phase's whole claim would quietly become
 * false.
 */
export async function proposalRenderInput(
  companyId: string,
  proposalId: string,
  createdAt: Date,
  exec: Executor = db,
): Promise<RenderInput> {
  const [row] = await exec
    .select({ proposal: proposals, company: companies })
    .from(proposals)
    .innerJoin(companies, eq(companies.id, proposals.companyId))
    .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, companyId)))
    .limit(1)

  if (!row) throw new NoDocumentError()

  const [document] = await exec
    .select()
    .from(designDocuments)
    .where(
      and(
        eq(designDocuments.proposalId, proposalId),
        eq(designDocuments.companyId, companyId),
      ),
    )
    .limit(1)

  if (!document) throw new NoDocumentError()

  const rendered = await proposalRenderContext(companyId, proposalId, exec)
  const items = rendered?.items ?? []
  const brand = await brandFor(companyId, document.brandKitId, exec)

  return {
    // Forgiving on read, as `parseBlocks` is everywhere else: a single
    // malformed block should not stop a client receiving their proposal.
    blocks: parseBlocks(document.blocks),
    brand,
    merge: rendered?.context ?? {},
    pageSize: document.pageSize as 'letter' | 'a4' | 'legal',
    orientation: document.orientation as 'portrait' | 'landscape',
    headerText: document.headerText,
    footerText: document.footerText,
    showPageNumbers: document.showPageNumbers,
    lines: items.map((item) => ({
      description: item.description,
      quantityMilli: item.quantityMilli,
      unitPriceCents: item.unitPriceCents,
      amountCents: item.amountCents,
      isOptional: item.isOptional,
      isSelected: item.isSelected,
    })),
    totals: {
      subtotalCents: row.proposal.subtotalCents,
      discountCents: row.proposal.discountCents,
      taxCents: row.proposal.taxCents,
      totalCents: row.proposal.totalCents,
    },
    title: `${row.proposal.number} ${row.proposal.title}`.trim(),
    author: row.company.name,
    createdAt,
  }
}

/**
 * Renders a proposal as it stands right now.
 *
 * A preview. What a *client* holds is the snapshot taken at send time, and the
 * two are deliberately different functions: this one follows the live record,
 * that one never moves.
 */
export async function renderProposalPreview(
  ctx: ActorContext,
  proposalId: string,
  at: Date,
): Promise<Buffer> {
  requirePermission(ctx, 'proposals:view')
  const input = await proposalRenderInput(ctx.companyId, proposalId, at)
  return renderDocumentPdf(input)
}

/**
 * Renders the proposal and files the bytes against the version just created.
 *
 * Called inside `sendProposal`'s transaction, so a proposal is never recorded
 * as sent without the document the client was sent. The alternative — render
 * afterwards, on a queue — leaves a window in which the version exists, the
 * client has the link, and the snapshot does not exist yet, which is precisely
 * the window in which somebody edits the price list.
 *
 * The bytes go into Phase 20's content-addressed store, which gives this phase
 * its proof for free: the digest *is* the evidence that nothing changed.
 */
export async function snapshotProposalPdf(
  ctx: ActorContext,
  input: { proposalId: string; versionId: string; sentAt: Date },
  exec: Executor,
): Promise<{ documentId: string; digest: string } | null> {
  let render: RenderInput
  try {
    render = await proposalRenderInput(ctx.companyId, input.proposalId, input.sentAt, exec)
  } catch (error) {
    // A proposal with no design document can still be sent — the CRM allows
    // one to exist before anybody opens the designer. Refusing the send would
    // be the wrong trade: the record of what was sent matters more than the
    // rendering of it, and the version still says so.
    if (error instanceof NoDocumentError) return null
    throw error
  }

  const bytes = renderDocumentPdf(render)

  const stored = await storeDocument(
    ctx,
    {
      filename: `${slug(render.title)}.pdf`,
      contentType: 'application/pdf',
      data: bytes,
      note: 'Sent to the client. This file is the record of what they received.',
    },
    exec,
  )

  await attachDocument(
    ctx,
    { subjectType: 'proposal_version', subjectId: input.versionId, documentId: stored.id },
    exec,
  )

  await exec
    .update(proposalVersions)
    .set({ pdfDocumentId: stored.id })
    .where(eq(proposalVersions.id, input.versionId))

  return { documentId: stored.id, digest: stored.digest }
}

/** The sent versions of one proposal, newest first, with their documents. */
export async function proposalVersionHistory(ctx: ActorContext, proposalId: string) {
  requirePermission(ctx, 'proposals:view')

  return db
    .select({
      id: proposalVersions.id,
      versionNumber: proposalVersions.versionNumber,
      totalCents: proposalVersions.totalCents,
      sentAt: proposalVersions.sentAt,
      pdfDocumentId: proposalVersions.pdfDocumentId,
    })
    .from(proposalVersions)
    .where(scoped(ctx, proposalVersions, eq(proposalVersions.proposalId, proposalId)))
    .orderBy(asc(proposalVersions.versionNumber))
}

/**
 * Every sent version in the company, grouped by proposal.
 *
 * One query for a whole list page. The alternative — asking per row — is the
 * shape that makes people show a version count and nothing else, and a count
 * does not answer "what did we quote them in March?".
 */
export async function sentVersions(ctx: ActorContext) {
  requirePermission(ctx, 'proposals:view')

  const rows = await db
    .select({
      proposalId: proposalVersions.proposalId,
      id: proposalVersions.id,
      versionNumber: proposalVersions.versionNumber,
      sentAt: proposalVersions.sentAt,
      pdfDocumentId: proposalVersions.pdfDocumentId,
    })
    .from(proposalVersions)
    .where(scoped(ctx, proposalVersions))
    .orderBy(asc(proposalVersions.versionNumber))

  const grouped = new Map<string, Array<Omit<(typeof rows)[number], 'proposalId'>>>()
  for (const { proposalId, ...version } of rows) {
    const list = grouped.get(proposalId) ?? []
    list.push(version)
    grouped.set(proposalId, list)
  }

  return grouped
}

/**
 * The document a client should be shown for a public link.
 *
 * The most recent *sent* version, never the live record. A client who opens
 * their link a week after the price list changed sees what they were sent.
 */
export async function latestSentPdf(
  companyId: string,
  proposalId: string,
): Promise<{ documentId: string; versionNumber: number } | null> {
  const rows = await db
    .select({
      documentId: proposalVersions.pdfDocumentId,
      versionNumber: proposalVersions.versionNumber,
    })
    .from(proposalVersions)
    .where(
      and(
        eq(proposalVersions.proposalId, proposalId),
        eq(proposalVersions.companyId, companyId),
      ),
    )
    .orderBy(asc(proposalVersions.versionNumber))

  const withPdf = rows.filter((row) => row.documentId)
  const last = withPdf[withPdf.length - 1]

  return last?.documentId
    ? { documentId: last.documentId, versionNumber: last.versionNumber }
    : null
}

/** A filename a person would not mind seeing in their downloads folder. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'document'
  )
}
