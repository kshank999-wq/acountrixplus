import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listProposals, schedulesFor } from '@/modules/crm/proposals'
import { listOpportunities } from '@/modules/crm/opportunities'
import { categorizableAccounts } from '@/modules/coa/service'
import { listServiceItems } from '@/modules/studio/service'
import { CRM_NAV } from '../nav'
import { sentVersions } from '@/modules/pdf/service'
import { ProposalList } from './proposal-list'
import { UnansweredQuestions } from './questions'
import { unansweredQuestions } from '@/modules/engagement/questions'

export const dynamic = 'force-dynamic'

export default async function ProposalsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'proposals:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Proposals</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to proposals.
        </p>
      </main>
    )
  }

  const canManage = can(actor, 'proposals:manage')

  const [proposals, opportunities, accounts, services, waiting] = await Promise.all([
    listProposals(actor),
    listOpportunities(actor, {
      stages: ['new_inquiry', 'qualified', 'proposal_draft', 'proposal_sent', 'viewed', 'follow_up', 'negotiation'],
    }),
    // Revenue accounts, so a won proposal can become an invoice without re-entry.
    can(actor, 'bookkeeping:view') ? categorizableAccounts(actor) : Promise.resolve([]),
    /*
      The service catalogue, so a proposal line can say which product it is
      (Phase 168, §9's performance-by-service dimension). Active items only —
      a deactivated service should not be quotable, and the existing lines that
      point at one keep their reference.
    */
    listServiceItems(actor, { activeOnly: true }),
    /*
      Questions a client asked through their link and nobody has answered
      (Phase 174). On this screen rather than the dashboard because this is
      where somebody goes when they are thinking about a proposal.
    */
    unansweredQuestions(actor),
  ])

  // One query for every sent version across the page, rather than one per
  // proposal. What a client was sent is the question this list is most often
  // opened to answer, so it belongs here and not behind a click.
  const versions = await sentVersions(actor)
  // One query for every proposal's schedule rather than one per row, which is
  // the same reason `sentVersions` is fetched here (Phase 154).
  const schedules = await schedulesFor(actor)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="crm"
    >
      <SubNav items={CRM_NAV} active="/crm/proposals" />

      <UnansweredQuestions
        waiting={waiting.map((question) => ({
          id: question.id,
          proposalNumber: question.proposalNumber,
          summary: question.summary,
          body: question.body,
          occurredAt: question.occurredAt.toISOString().slice(0, 10),
          // Computed here rather than in the browser: a day count from a clock
          // the client sets is a figure that disagrees with the server's.
          waitingDays: Math.floor(
            (Date.now() - question.occurredAt.getTime()) / 86_400_000,
          ),
        }))}
      />

      <ProposalList
        proposals={proposals.map((p) => ({
          id: p.id,
          number: p.number,
          title: p.title,
          status: p.status,
          totalCents: p.totalCents,
          organizationName: p.organizationName,
          sentAt: p.sentAt ? p.sentAt.toISOString().slice(0, 10) : null,
          viewCount: p.viewCount,
          expiresOn: p.expiresOn,
          publicToken: p.publicToken,
          versions: (versions.get(p.id) ?? []).map((version) => ({
            id: version.id,
            versionNumber: version.versionNumber,
            sentAt: version.sentAt.toISOString().slice(0, 10),
            hasPdf: version.pdfDocumentId !== null,
          })),
          schedule: schedules.get(p.id) ?? [],
        }))}
        opportunities={opportunities.map((o) => ({
          id: o.id,
          title: o.title,
          organizationName: o.organizationName,
        }))}
        revenueAccounts={accounts
          .filter((a) => a.type === 'revenue')
          .map((a) => ({ id: a.id, number: a.number, name: a.name }))}
        services={services.map((item) => ({
          id: item.id,
          code: item.code,
          name: item.name,
          unitPriceCents: item.unitPriceCents,
          chartAccountId: item.chartAccountId,
          defaultProposalCopy: item.defaultProposalCopy,
        }))}
        canManage={canManage}
      />
    </AppShell>
  )
}
