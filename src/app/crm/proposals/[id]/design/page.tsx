import { notFound } from 'next/navigation'
import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { brandKits } from '@/db/schema'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { getProposal } from '@/modules/crm/proposals'
import { documentForProposal, listTemplates, proposalRenderContext } from '@/modules/design/documents'
import { listClauses } from '@/modules/studio/service'
import { listAssets } from '@/modules/studio/assets'
import { parseBlocks } from '@/modules/design/blocks'
import { unresolvedInBlocks } from '@/modules/design/merge-fields'
import { Designer } from '@/components/design/designer'

export const dynamic = 'force-dynamic'

/** The proposal designer (spec §7). */
export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor()
  const session = await requireSession()
  const { id } = await params

  if (!can(actor, 'proposals:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Proposal designer</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to proposals.
        </p>
      </main>
    )
  }

  let proposalData
  try {
    proposalData = await getProposal(actor, id)
  } catch {
    notFound()
  }

  const { proposal, items } = proposalData
  const document = await documentForProposal(actor, id)

  const [templates, clauses, assets, render] = await Promise.all([
    listTemplates(actor),
    listClauses(actor),
    listAssets(actor),
    proposalRenderContext(actor.companyId, id),
  ])

  const [kit] = document.brandKitId
    ? await db.select().from(brandKits).where(eq(brandKits.id, document.brandKitId)).limit(1)
    : []

  const context = render?.context ?? {}
  const unresolved = unresolvedInBlocks(parseBlocks(document.blocks), context)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="crm"
      actions={
        <Link href={`/p/${proposal.publicToken}`} target="_blank" className="btn text-xs">
          Preview client view
        </Link>
      }
    >
      <Designer
        documentId={document.id}
        kind="proposal"
        eyebrow={proposal.number}
        title={proposal.title}
        isEditable={proposal.status === 'draft' && can(actor, 'proposals:manage')}
        statusNote={`This proposal is ${proposal.status.replace('_', ' ')} — its sent version is locked.`}
        initialBlocks={parseBlocks(document.blocks)}
        setup={{
          pageSize: document.pageSize,
          orientation: document.orientation,
          marginTopPt: document.marginTopPt,
          marginRightPt: document.marginRightPt,
          marginBottomPt: document.marginBottomPt,
          marginLeftPt: document.marginLeftPt,
          headerText: document.headerText,
          footerText: document.footerText,
        }}
        brand={
          kit
            ? {
                primaryColor: kit.primaryColor,
                accentColor: kit.accentColor,
                textColor: kit.textColor,
                mutedColor: kit.mutedColor,
                surfaceColor: kit.surfaceColor,
                headingFont: kit.headingFont,
                bodyFont: kit.bodyFont,
                baseSizePt: kit.baseSizePt,
                logoAssetId: kit.logoAssetId,
              }
            : null
        }
        context={context}
        unresolvedFields={unresolved}
        items={items.map((item) => ({
          id: item.id,
          description: item.description,
          quantityMilli: item.quantityMilli,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          isOptional: item.isOptional,
          isSelected: item.isSelected,
        }))}
        discountCents={proposal.discountCents}
        taxCents={proposal.taxCents}
        templates={templates.map((template) => ({
          key: template.key,
          name: template.name,
          description: template.description,
          source: template.source,
          industry: template.industry,
        }))}
        clauses={clauses.map((clause) => ({
          id: clause.currentVersionId ?? clause.id,
          title: clause.title,
          body: clause.body ?? '',
          approved: Boolean(clause.approvedAt),
        }))}
        assets={assets.map((asset) => ({ id: asset.id, filename: asset.filename }))}
      />
    </AppShell>
  )
}
