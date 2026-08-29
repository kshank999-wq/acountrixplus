import Link from 'next/link'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatBasisPoints } from '@/modules/crm/analytics'
import {
  marketingOverview,
  openTasks,
  recentEvents,
  reEngagementCandidates,
} from '@/modules/marketing/analytics'
import { campaignCalendar } from '@/modules/marketing/analytics'
import { MARKETING_NAV, EVENT_LABELS } from './nav'
import { Card, Empty, NoAccess, Stat, Table } from './ui'
import { TaskRow, ReEngageRow } from './sales-loop'

export const dynamic = 'force-dynamic'

/**
 * The marketing overview (spec §10).
 *
 * Two halves, deliberately on one page: what went out, and what came back.
 * The point of spec §10's marketing-to-sales loop is that engagement is only
 * worth measuring if somebody acts on it, so the tasks and the re-engagement
 * list sit next to the open rate rather than a click away.
 */
export default async function MarketingOverviewPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'marketing:view')) {
    return <NoAccess role={actor.role} what="Marketing" />
  }

  const [overview, tasks, candidates, events, calendar] = await Promise.all([
    marketingOverview(actor),
    can(actor, 'crm:view') ? openTasks(actor) : Promise.resolve([]),
    reEngagementCandidates(actor),
    recentEvents(actor, undefined, 12),
    campaignCalendar(actor, new Date()),
  ])

  const canManage = can(actor, 'marketing:manage')
  const canWorkDeals = can(actor, 'crm:manage')

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="marketing"
      actions={
        canManage ? (
          <Link href="/marketing/campaigns" className="btn btn-primary text-xs">
            New campaign
          </Link>
        ) : undefined
      }
    >
      <SubNav items={MARKETING_NAV} active="/marketing" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Campaigns" value={String(overview.campaignCount)} hint={`${overview.sentCount} sent`} />
        <Stat label="Messages delivered" value={String(overview.totalSent)} />
        <Stat label="Open rate" value={formatBasisPoints(overview.openRateBp)} accent />
        <Stat label="Click rate" value={formatBasisPoints(overview.clickRateBp)} accent />
        <Stat label="Opened" value={String(overview.totalOpened)} />
        <Stat label="Clicked" value={String(overview.totalClicked)} />
        <Stat label="Unsubscribed" value={String(overview.totalUnsubscribed)} />
        <Stat
          label="Follow-ups waiting"
          value={String(overview.openTasks)}
          hint={`${overview.reEngagementCandidates} deals worth reopening`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Follow up while it is warm"
          subtitle="Raised automatically when someone clicks a campaign link."
        >
          {tasks.length === 0 ? (
            <Empty>Nothing waiting. Tasks appear here when a contact engages.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  id={task.id}
                  title={task.title}
                  detail={task.detail}
                  dueOn={task.dueOn}
                  organizationName={task.organizationName}
                  canComplete={canWorkDeals}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Lost deals showing interest"
          subtitle="Marked eligible for nurture at close, and engaging again."
        >
          {candidates.length === 0 ? (
            <Empty>
              None yet. A deal appears here once someone from that client clicks a campaign
              link.
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {candidates.map((row) => (
                <ReEngageRow
                  key={row.opportunityId}
                  opportunityId={row.opportunityId}
                  organizationName={row.organizationName}
                  opportunityTitle={row.opportunityTitle}
                  lossReason={row.lossReason}
                  campaignName={row.campaignName}
                  lastClickedAt={row.lastClickedAt?.toISOString() ?? null}
                  canReopen={canWorkDeals}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent engagement" subtitle="Newest first.">
          {events.length === 0 ? (
            <Empty>No engagement recorded yet.</Empty>
          ) : (
            <Table
              head={['When', 'Who', 'Campaign', 'What']}
              rows={events.map((event) => [
                event.occurredAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '',
                event.email,
                event.campaignName,
                EVENT_LABELS[event.kind] ?? event.kind,
              ])}
            />
          )}
        </Card>

        <Card title="Coming up" subtitle="Campaigns with a scheduled date.">
          {calendar.length === 0 ? (
            <Empty>Nothing scheduled.</Empty>
          ) : (
            <Table
              head={['Date', 'Campaign', 'Kind', 'Status']}
              rows={calendar.map((row) => [
                row.scheduledFor?.toISOString().slice(0, 10) ?? '',
                <Link
                  key={row.id}
                  href={`/marketing/campaigns/${row.id}`}
                  className="text-action hover:underline"
                >
                  {row.name}
                </Link>,
                row.kind,
                row.status,
              ])}
            />
          )}
        </Card>
      </div>
    </AppShell>
  )
}
