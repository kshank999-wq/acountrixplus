import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { listContacts, listOrganizations } from '@/modules/crm/opportunities'
import { listProjects } from '@/modules/crm/conversion'
import { CRM_NAV } from '../nav'
import { lastContactedAt } from '@/modules/engagement/communications'
import { NewOrganization } from './new-organization'
import { ClientTimeline } from './client-timeline'

export const dynamic = 'force-dynamic'

const STAGE_LABELS: Record<string, string> = {
  lead: 'Lead',
  prospect: 'Prospect',
  active_client: 'Active client',
  former_client: 'Former client',
  vendor: 'Vendor',
  strategic_target: 'Strategic target',
}

const STAGE_STYLES: Record<string, string> = {
  lead: 'bg-raised text-muted',
  prospect: 'bg-warning/15 text-warning',
  active_client: 'bg-positive/15 text-positive',
  former_client: 'bg-raised text-faint',
  vendor: 'bg-raised text-muted',
  strategic_target: 'bg-action/10 text-action',
}

export default async function OrganizationsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'crm:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Clients</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the CRM.
        </p>
      </main>
    )
  }

  const [organizations, contacts, projects] = await Promise.all([
    listOrganizations(actor, { limit: 500 }),
    listContacts(actor),
    listProjects(actor),
  ])

  // One query for the whole page. "When did we last speak to these people" is
  // the question a client list is opened to answer, and asking it per row is
  // how it ends up not being shown at all.
  const spokenTo = await lastContactedAt(
    actor,
    organizations.map((organization) => organization.id),
  )

  const contactsByOrg = new Map<string, typeof contacts>()
  for (const contact of contacts) {
    if (!contact.organizationId) continue
    const list = contactsByOrg.get(contact.organizationId) ?? []
    list.push(contact)
    contactsByOrg.set(contact.organizationId, list)
  }

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="crm"
    >
      <SubNav items={CRM_NAV} active="/crm/organizations" />

      {can(actor, 'crm:manage') && <NewOrganization />}

      <section className="card mt-4 overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Clients and prospects</h2>
          <p className="text-xs text-muted">
            One record per organization. Being a customer or a vendor is a role it plays in
            accounting, not a separate record.
          </p>
        </header>

        {organizations.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">
            No organizations yet. Add one, or let the lead intake form create them.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {organizations.map((organization) => {
              const people = contactsByOrg.get(organization.id) ?? []
              return (
                <li key={organization.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{organization.name}</p>
                      <p className="truncate text-xs text-faint">
                        {[organization.industry, organization.region, organization.source]
                          .filter(Boolean)
                          .join(' · ') || 'No details yet'}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {organization.isStrategicAccount && (
                        <span className="chip bg-action/10 text-action">Strategic</span>
                      )}
                      <span
                        className={`chip ${STAGE_STYLES[organization.lifecycleStage] ?? 'bg-raised text-muted'}`}
                      >
                        {STAGE_LABELS[organization.lifecycleStage] ?? organization.lifecycleStage}
                      </span>
                    </div>
                  </div>

                  <ClientTimeline
                    organizationId={organization.id}
                    organizationName={organization.name}
                    lastContacted={
                      spokenTo.get(organization.id)?.toISOString().slice(0, 10) ?? null
                    }
                  />

                  {people.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {people.map((contact) => (
                        <li
                          key={contact.id}
                          className="rounded-lg bg-raised px-2 py-1 text-xs"
                          title={contact.email ?? undefined}
                        >
                          {[contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
                            contact.email}
                          {contact.emailConsent === 'subscribed' && (
                            <span className="ml-1 text-positive">· opted in</span>
                          )}
                          {contact.suppressedAt && (
                            <span className="ml-1 text-negative">· suppressed</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="card mt-4 overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Jobs</h2>
          <p className="text-xs text-muted">
            Created when an opportunity is won. Also an accounting dimension on journal lines.
          </p>
        </header>

        {projects.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No jobs yet — win an opportunity and convert it.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Code</th>
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 text-right font-medium">Contract value</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} className="border-t border-line">
                    <td className="tnum px-4 py-1.5 text-faint">{project.code}</td>
                    <td className="px-4 py-1.5">{project.name}</td>
                    <td className="px-4 py-1.5">{project.organizationName ?? '—'}</td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatCents(project.contractValueCents)}
                    </td>
                    <td className="px-4 py-1.5">
                      <span className="chip bg-raised text-muted">{project.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  )
}
