import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { inboxCounts, listInbox, UNREVIEWED_STATES, type ReviewState } from '@/modules/bookkeeping/transactions'
import { categorizableAccounts } from '@/modules/coa/service'
import { listFinancialAccounts } from '@/modules/banking/sync'
import { logoutAction } from '@/app/actions/auth'
import { Inbox } from './inbox'
import { SyncButton } from './sync-button'

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

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">
              {session?.companyName ?? 'Accountrix Plus'}
            </h1>
            <p className="truncate text-xs text-muted">
              Bookkeeping · {actor.userName} ({actor.role})
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {can(actor, 'bookkeeping:import') && <SyncButton />}
            <form action={logoutAction}>
              <button className="btn text-xs">Sign out</button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
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
          canManageRules={canManageRules}
        />
      </main>
    </div>
  )
}
