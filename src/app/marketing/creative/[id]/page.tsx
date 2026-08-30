import { notFound } from 'next/navigation'
import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { brandKits } from '@/db/schema'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { Designer } from '@/components/design/designer'
import {
  getDocument,
  listTemplates,
  marketingRenderContext,
} from '@/modules/design/documents'
import { listClauses } from '@/modules/studio/service'
import { listAssets } from '@/modules/studio/assets'
import { parseBlocks } from '@/modules/design/blocks'
import { NoAccess } from '../../ui'

export const dynamic = 'force-dynamic'

/**
 * The marketing creative designer (spec §8).
 *
 * The same component the proposal designer uses, given a different block
 * palette and a sample merge context. ADR 0004 predicted this would be
 * possible; that it needed no engine change is the evidence.
 */
export default async function CreativeDesignPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()
  const { id } = await params

  if (!can(actor, 'marketing:view')) {
    return <NoAccess role={actor.role} what="Creative designer" />
  }

  let document
  try {
    document = await getDocument(actor, id)
  } catch {
    notFound()
  }

  const [templates, clauses, assets, context] = await Promise.all([
    listTemplates(actor),
    listClauses(actor),
    listAssets(actor),
    marketingRenderContext(actor.companyId),
  ])

  const [kit] = document.brandKitId
    ? await db.select().from(brandKits).where(eq(brandKits.id, document.brandKitId)).limit(1)
    : []

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="marketing"
      actions={
        <Link href="/marketing/creative" className="btn text-xs">
          All creative
        </Link>
      }
    >
      <Designer
        documentId={document.id}
        kind="marketing"
        title={document.name}
        isEditable={can(actor, 'marketing:manage')}
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
        // Merge fields are filled per recipient at send time, so an unresolved
        // field here is expected rather than a warning worth showing.
        unresolvedFields={[]}
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
