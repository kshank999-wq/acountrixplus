import Link from 'next/link'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listCampaigns } from '@/modules/marketing/campaigns'
import { listSegments } from '@/modules/marketing/audience'
import { MARKETING_NAV } from '../nav'
import { Card, Empty, NoAccess } from '../ui'
import { CampaignComposer } from './campaign-composer'

export const dynamic = 'force-dynamic'

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-raised text-muted',
  scheduled: 'bg-action/10 text-action',
  sending: 'bg-warning/15 text-warning',
  sent: 'bg-positive/15 text-positive',
  paused: 'bg-raised text-muted',
  cancelled: 'bg-negative/15 text-negative',
}

/** The campaign list (spec §10). */
export default async function CampaignsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'marketing:view')) {
    return <NoAccess role={actor.role} what="Campaigns" />
  }

  const [campaigns, segments] = await Promise.all([listCampaigns(actor), listSegments(actor)])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="marketing"
    >
      <SubNav items={MARKETING_NAV} active="/marketing/campaigns" />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title="Campaigns" subtitle="Newest first.">
          {campaigns.length === 0 ? (
            <Empty>No campaigns yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {campaigns.map((campaign) => (
                <li key={campaign.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/marketing/campaigns/${campaign.id}`}
                      className="text-sm font-medium text-action hover:underline"
                    >
                      {campaign.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted">
                      {campaign.kind === 'nurture' ? 'Nurture sequence' : 'Broadcast'}
                      {campaign.segmentName
                        ? ` · to ${campaign.segmentName}`
                        : ' · no audience chosen'}
                    </p>
                    {campaign.scheduledFor && (
                      <p className="mt-0.5 text-xs text-faint">
                        Scheduled {campaign.scheduledFor.toISOString().slice(0, 10)}
                      </p>
                    )}
                  </div>

                  <span
                    className={`chip shrink-0 ${STATUS_STYLES[campaign.status] ?? 'bg-raised text-muted'}`}
                  >
                    {campaign.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {can(actor, 'marketing:manage') && (
          <CampaignComposer
            segments={segments.map((segment) => ({ id: segment.id, name: segment.name }))}
            defaultFromName={session?.companyName ?? ''}
          />
        )}
      </div>
    </AppShell>
  )
}
