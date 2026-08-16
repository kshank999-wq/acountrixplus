import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { brandKits, designDocuments, proposalAcceptances } from '@/db/schema'
import { proposalByToken, recordView } from '@/modules/crm/proposals'
import { isAcceptable } from '@/modules/crm/acceptance'
import { proposalRenderContext } from '@/modules/design/documents'
import { truncateIp } from '@/modules/crm/intake'
import { DocumentPage, brandTokens } from '@/components/design/document-page'
import { AcceptancePanel } from './acceptance-panel'
import { PrintButton } from './print-button'
import { latestSentPdf } from '@/modules/pdf/service'

export const dynamic = 'force-dynamic'

/**
 * The client-facing proposal (spec §7, §9).
 *
 * Unauthenticated and read-only apart from acceptance. It renders the same
 * design document the author edited, under the company's brand, with a print
 * stylesheet so the client's own Print → Save as PDF produces a paginated,
 * print-ready file.
 */
export default async function PublicProposalPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const view = await proposalByToken(token)
  if (!view) notFound()

  const { proposal, organizationName } = view

  const headerStore = await headers()
  await recordView(token, {
    ipPrefix: truncateIp(headerStore.get('x-forwarded-for') ?? headerStore.get('x-real-ip')),
    userAgent: headerStore.get('user-agent'),
  })

  const [render, existingAcceptance, documents] = await Promise.all([
    proposalRenderContext(proposal.companyId, proposal.id),
    db
      .select()
      .from(proposalAcceptances)
      .where(
        and(
          eq(proposalAcceptances.proposalId, proposal.id),
          eq(proposalAcceptances.companyId, proposal.companyId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(designDocuments)
      .where(
        and(
          eq(designDocuments.proposalId, proposal.id),
          eq(designDocuments.companyId, proposal.companyId),
        ),
      )
      .limit(1),
  ])

  const document = documents[0]

  const [kit] = document?.brandKitId
    ? await db.select().from(brandKits).where(eq(brandKits.id, document.brandKitId)).limit(1)
    : []

  const accepted = existingAcceptance[0] ?? null
  const acceptable = isAcceptable(proposal) && !accepted

  const items = (render?.items ?? []).map((item) => ({
    id: item.id,
    description: item.description,
    quantityMilli: item.quantityMilli,
    unitPriceCents: item.unitPriceCents,
    amountCents: item.amountCents,
    isOptional: item.isOptional,
    isSelected: item.isSelected,
  }))

  const assetUrl = (assetId: string) =>
    `/api/assets/${assetId}?proposal=${encodeURIComponent(token)}`

  const logoAssetId = kit?.logoAssetId ?? null

  const setup = document ?? {
    pageSize: 'letter',
    orientation: 'portrait',
    marginTopPt: 54,
    marginRightPt: 54,
    marginBottomPt: 54,
    marginLeftPt: 54,
    headerText: null,
    footerText: null,
  }

  // The download offers the snapshot taken when this was sent — not a render
  // of the live record, which may since have moved. Absent for a proposal sent
  // before it had a design document, and the button is simply not offered.
  const hasIssuedPdf = Boolean(await latestSentPdf(proposal.companyId, proposal.id))

  return (
    <div className="min-h-screen bg-canvas py-6 print:bg-white print:py-0">
      <div className="doc-screen-only mx-auto mb-4 flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4">
        <p className="text-xs text-muted">
          Proposal {proposal.number} for {organizationName}
        </p>
        <div className="flex items-center gap-2">
          {hasIssuedPdf && (
            <a href={`/p/${token}/pdf`} target="_blank" rel="noreferrer" className="btn text-xs">
              Download the PDF
            </a>
          )}
          <PrintButton />
        </div>
      </div>

      <div className="mx-auto max-w-3xl bg-white shadow-sm print:max-w-none print:shadow-none">
        <DocumentPage
          blocks={document?.blocks ?? []}
          setup={setup}
          brand={brandTokens(kit)}
          context={render?.context ?? {}}
          data={{
            items,
            discountCents: proposal.discountCents,
            taxCents: proposal.taxCents,
            logoUrl: logoAssetId ? assetUrl(logoAssetId) : null,
            assetUrl,
            signatureSlot: (
              <AcceptancePanel
                token={token}
                items={items}
                discountCents={proposal.discountCents}
                taxCents={proposal.taxCents}
                acceptable={acceptable}
                accepted={
                  accepted
                    ? {
                        signerName: accepted.signerName,
                        acceptedAt: accepted.acceptedAt.toISOString().slice(0, 10),
                        totalCents: accepted.acceptedTotalCents,
                      }
                    : null
                }
                expired={
                  Boolean(proposal.expiresOn) &&
                  proposal.expiresOn! < new Date().toISOString().slice(0, 10)
                }
              />
            ),
          }}
        />
      </div>
    </div>
  )
}
