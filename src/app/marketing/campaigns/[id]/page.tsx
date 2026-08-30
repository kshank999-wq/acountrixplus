import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatBasisPoints } from '@/modules/crm/analytics'
import { campaignRecipientRows, getCampaign } from '@/modules/marketing/campaigns'
import { campaignStats, recentEvents } from '@/modules/marketing/analytics'
import { listSegments } from '@/modules/marketing/audience'
import { listDocuments } from '@/modules/design/documents'
import { MARKETING_NAV, EVENT_LABELS } from '../../nav'
import { Card, Empty, NoAccess, Stat, Table } from '../../ui'
import { CampaignSteps } from './campaign-steps'

export const dynamic = 'force-dynamic'

const SKIP_LABELS: Record<string, string> = {
  no_consent: 'had not opted in',
  suppressed: 'unsubscribed or bounced before',
  no_email: 'had no email address',
  unknown: 'were skipped',
}

/** One campaign: its steps, what it achieved, and who it reached (spec §10). */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor()
  const session = await requireSession()
  const { id } = await params

  if (!can(actor, 'marketing:view')) {
    return <NoAccess role={actor.role} what="Campaign" />
  }

  let data
  try {
    data = await getCampaign(actor, id)
  } catch {
    notFound()
  }

  const { campaign, steps } = data

  const [stats, recipients, events, segments, creatives] = await Promise.all([
    campaignStats(actor, id),
    campaignRecipientRows(actor, id),
    recentEvents(actor, id, 20),
    listSegments(actor),
    listDocuments(actor, 'marketing'),
  ])

  const segmentName = segments.find((segment) => segment.id === campaign.segmentId)?.name ?? null
  const canManage = can(actor, 'marketing:manage')

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="marketing"
      actions={
        <Link href="/marketing/campaigns" className="btn text-xs">
          All campaigns
        </Link>
      }
    >
      <SubNav items={MARKETING_NAV} active="/marketing/campaigns" />

      <header className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">{campaign.name}</h1>
        <p className="text-sm text-muted">
          {campaign.kind === 'nurture' ? 'Nurture sequence' : 'Broadcast'} ·{' '}
          {campaign.status}
          {segmentName ? ` · to ${segmentName}` : ' · no audience chosen'}
          {campaign.fromEmail ? ` · from ${campaign.fromEmail}` : ' · no from address set'}
        </p>
      </header>

      {stats.matched > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Delivered"
              value={String(stats.sent)}
              hint={`of ${stats.matched} matched`}
              accent
            />
            <Stat label="Open rate" value={formatBasisPoints(stats.openRateBp)} hint={`${stats.opened} opened`} />
            <Stat label="Click rate" value={formatBasisPoints(stats.clickRateBp)} hint={`${stats.clicked} clicked`} />
            <Stat
              label="Unsubscribed"
              value={String(stats.unsubscribed)}
              hint={formatBasisPoints(stats.unsubscribeRateBp)}
            />
          </div>

          {stats.skipped > 0 && (
            <p className="card mt-3 p-3 text-xs text-muted">
              {stats.skipped} of {stats.matched} people who matched this segment were not
              emailed:{' '}
              {Object.entries(stats.skipReasons)
                .map(([reason, count]) => `${count} ${SKIP_LABELS[reason] ?? reason}`)
                .join(', ')}
              . That is the consent check doing its job, not a delivery failure.
            </p>
          )}
        </>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CampaignSteps
          campaignId={id}
          status={campaign.status}
          canManage={canManage}
          hasAudience={Boolean(campaign.segmentId)}
          hasFromAddress={Boolean(campaign.fromEmail)}
          steps={steps.map((step) => ({
            id: step.id,
            stepNumber: step.stepNumber,
            subject: step.subject,
            previewText: step.previewText,
            delayDays: step.delayDays,
            designDocumentId: step.designDocumentId,
          }))}
          creatives={creatives.map((doc) => ({ id: doc.id, name: doc.name }))}
        />

        <Card title="Recent engagement" subtitle="Opens, clicks, and unsubscribes.">
          {events.length === 0 ? (
            <Empty>Nothing yet.</Empty>
          ) : (
            <Table
              head={['When', 'Who', 'What']}
              rows={events.map((event) => [
                event.occurredAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '',
                event.email,
                EVENT_LABELS[event.kind] ?? event.kind,
              ])}
            />
          )}
        </Card>

        <div className="lg:col-span-2">
          <Card
            title="Recipients"
            subtitle="Everyone the segment matched, including those not emailed."
          >
            {recipients.length === 0 ? (
              <Empty>Nobody yet — this campaign has not been sent.</Empty>
            ) : (
              <Table
                head={['Email', 'Status', 'Opened', 'Clicked', 'Why not sent']}
                rows={recipients.map((row) => [
                  row.email,
                  row.status,
                  row.openedAt ? row.openedAt.toISOString().slice(0, 10) : '—',
                  row.clickedAt ? row.clickedAt.toISOString().slice(0, 10) : '—',
                  row.skipReason ? (SKIP_LABELS[row.skipReason] ?? row.skipReason) : '—',
                ])}
              />
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
