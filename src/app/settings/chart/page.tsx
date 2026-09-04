import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, journalLines } from '@/db/schema'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { functionalCurrency } from '@/modules/fx/service'
import { SETTINGS_NAV } from '../nav'
import { ChartBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The chart of accounts (spec §5, Phase 118).
 *
 * There was no screen for this. `createAccount` was written in Phase 1 —
 * *"spec §5 allows full customization"* — and called by nothing for 117
 * phases, and the chart itself appeared only as a dropdown inside other
 * screens. A business could neither read the accounts its own balance sheet is
 * built from nor add one.
 *
 * The counts and balances are read here rather than left off, because the two
 * questions somebody has in front of a chart are *what is this account for* and
 * *is anything in it* — and the second is what decides whether an account can
 * be retired.
 */
export default async function ChartPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'bookkeeping:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Chart of accounts</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the bookkeeping workspace.
        </p>
      </main>
    )
  }

  const [rows, currency] = await Promise.all([
    db
      .select({
        id: chartAccounts.id,
        number: chartAccounts.number,
        name: chartAccounts.name,
        type: chartAccounts.type,
        isSystem: chartAccounts.isSystem,
        isActive: chartAccounts.isActive,
        postings: sql<string>`count(${journalLines.id})`,
        // Signed in the account's normal direction, the same rule the trial
        // balance and every register use.
        balanceCents: sql<string>`coalesce(sum(
          case when ${chartAccounts.type} in ('asset', 'cogs', 'expense', 'other_expense')
               then ${journalLines.debitCents} - ${journalLines.creditCents}
               else ${journalLines.creditCents} - ${journalLines.debitCents}
          end), 0)`,
      })
      .from(chartAccounts)
      .leftJoin(journalLines, eq(journalLines.chartAccountId, chartAccounts.id))
      .where(and(eq(chartAccounts.companyId, actor.companyId)))
      .groupBy(
        chartAccounts.id,
        chartAccounts.number,
        chartAccounts.name,
        chartAccounts.type,
        chartAccounts.isSystem,
        chartAccounts.isActive,
      ),
    functionalCurrency(actor.companyId),
  ])

  return (
    <AppShell actor={actor} companyName={session.companyName} active="bookkeeping">
      <SubNav items={SETTINGS_NAV} active="/settings/chart" />
      <ChartBoard
        accounts={rows.map((row) => ({
          id: row.id,
          number: row.number,
          name: row.name,
          type: row.type,
          isSystem: row.isSystem,
          isActive: row.isActive,
          postings: Number(row.postings),
          balanceCents: Number(row.balanceCents),
        }))}
        currency={currency}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
