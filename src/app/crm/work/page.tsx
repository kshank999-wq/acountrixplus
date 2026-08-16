import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { closedWork, myWork, openWork, workSummary } from '@/modules/engagement/tasks'
import { whoHasAccess } from '@/modules/practice/service'
import { listOrganizations } from '@/modules/crm/opportunities'
import { CRM_NAV } from '../nav'
import { WorkBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * What is on somebody's desk (spec §16 `Task`, §10 sales loop).
 *
 * Leads with the person's own work rather than the company's, because the
 * question this page is opened to answer is "what am I doing today" — and a
 * list that opens on forty other people's follow-ups is one nobody reads
 * twice.
 */
export default async function WorkPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'crm:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Follow-ups</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to clients and sales.
        </p>
      </main>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  // One week back, computed once and passed to both, so the count in the header
  // and the list under it are counted over the same window.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const [mine, everything, closed, summary, people, organizations] = await Promise.all([
    myWork(actor),
    openWork(actor, { asOf: today }),
    closedWork(actor, { since }),
    workSummary(actor, today, since),
    whoHasAccess(actor),
    listOrganizations(actor),
  ])

  return (
    <AppShell actor={actor} companyName={session?.companyName ?? 'Accountrix Plus'} active="crm">
      <SubNav items={CRM_NAV} active="/crm/work" />
      <WorkBoard
        today={today}
        mine={mine.map(serialize)}
        everything={everything.map(serialize)}
        closed={closed.map(serialize)}
        summary={summary}
        people={people.map((person) => ({ id: person.userId, name: person.name }))}
        organizations={organizations.map((organization) => ({
          id: organization.id,
          name: organization.name,
        }))}
        selfUserId={actor.userId}
        canManage={can(actor, 'crm:manage')}
      />
    </AppShell>
  )
}

function serialize(task: Awaited<ReturnType<typeof myWork>>[number]) {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    dueOn: task.dueOn,
    priority: task.priority,
    assignedTo: task.assignedTo,
    assigneeName: task.assigneeName,
    organizationName: task.organizationName,
    status: task.status,
    outcome: task.outcome,
  }
}
