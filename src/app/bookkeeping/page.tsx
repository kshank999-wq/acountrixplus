import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { inboxCounts, listInbox, UNREVIEWED_STATES, type ReviewState } from '@/modules/bookkeeping/transactions'
import { categorizableAccounts } from '@/modules/coa/service'
import { listFinancialAccounts } from '@/modules/banking/sync'
import { aiAvailable } from '@/modules/ai/settings'
import { logoutAction } from '@/app/actions/auth'
import { AppShell } from '@/components/app-shell'
import { Inbox } from './inbox'
import { SyncButton } from './sync-button'
import { AssistantPanel } from './assistant-panel'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{
  q?: string
  account?: string
  state?: string
  page?: string
}>

const PAGE_SIZE = 50

export default async function BookkeepingPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await requireActor()
  const session = await currentSession()
  const params = await searchParams

  // A user without bookkeeping access gets a plain explanation rather than a
  // crash — the service layer would throw PermissionError (spec §14).
  if (!can(actor, 'bookkeeping:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Bookkeeping</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to financial data. Ask an owner or
          admin if you need it.
        </p>
        <form action={logoutAction} className="mt-6">
          <button className="btn">Sign out</button>
        </form>
      </main>
    )
  }

  const page = Math.max(1, Number(params.page ?? '1') || 1)
  const states: ReviewState[] =
    params.state && params.state !== 'unreviewed'
      ? [params.state as ReviewState]
      : UNREVIEWED_STATES

  const [inbox, counts, accounts, financialAccounts] = await Promise.all([
    listInbox(actor, {
      states,
      search: params.q,
      financialAccountId: params.account || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    inboxCounts(actor),
    categorizableAccounts(actor),
    listFinancialAccounts(actor),
  ])

  const canEdit = can(actor, 'bookkeeping:categorize')
  const canManageRules = can(actor, 'bookkeeping:rules')
  // The assistant appears only when the company has switched the module on
  // and this person may use it — otherwise the inbox looks exactly as it did
  // before Phase 6 existed (spec §23).
  const aiEnabled = can(actor, 'ai:use') && (await aiAvailable(actor))

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="bookkeeping"
      actions={can(actor, 'bookkeeping:import') ? <SyncButton /> : null}
    >
      {aiEnabled && <AssistantPanel />}

      <Inbox
        rows={inbox.rows}
        total={inbox.total}
        page={page}
        pageSize={PAGE_SIZE}
        counts={counts}
        accounts={accounts.map((a) => ({ id: a.id, number: a.number, name: a.name }))}
        financialAccounts={financialAccounts.map((a) => ({
          id: a.id,
          name: a.name,
          mask: a.mask,
        }))}
        filters={{
          q: params.q ?? '',
          account: params.account ?? '',
          state: params.state ?? 'unreviewed',
        }}
        canEdit={canEdit}
        aiEnabled={aiEnabled}
        canManageRules={canManageRules}
      />
    </AppShell>
  )
}
