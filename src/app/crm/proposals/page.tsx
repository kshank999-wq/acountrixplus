import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listProposals } from '@/modules/crm/proposals'
import { listOpportunities } from '@/modules/crm/opportunities'
import { categorizableAccounts } from '@/modules/coa/service'
import { CRM_NAV } from '../nav'
import { sentVersions } from '@/modules/pdf/service'
import { ProposalList } from './proposal-list'

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

  const [proposals, opportunities, accounts] = await Promise.all([
    listProposals(actor),
    listOpportunities(actor, {
      stages: ['new_inquiry', 'qualified', 'proposal_draft', 'proposal_sent', 'viewed', 'follow_up', 'negotiation'],
    }),
    // Revenue accounts, so a won proposal can become an invoice without re-entry.
    can(actor, 'bookkeeping:view') ? categorizableAccounts(actor) : Promise.resolve([]),
  ])

  // One query for every sent version across the page, rather than one per
  // proposal. What a client was sent is the question this list is most often
  // opened to answer, so it belongs here and not behind a click.
  const versions = await sentVersions(actor)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="crm"
    >
      <SubNav items={CRM_NAV} active="/crm/proposals" />

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
        }))}
        opportunities={opportunities.map((o) => ({
          id: o.id,
          title: o.title,
          organizationName: o.organizationName,
        }))}
        revenueAccounts={accounts
          .filter((a) => a.type === 'revenue')
          .map((a) => ({ id: a.id, number: a.number, name: a.name }))}
        canManage={canManage}
      />
    </AppShell>
  )
}
