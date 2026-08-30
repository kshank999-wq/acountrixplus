import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listAccounts } from '@/modules/coa/service'
import { budgetForYear, budgetGrid, listBudgets } from '@/modules/budget/service'
import { budgetVsActual, type BudgetVsActual } from '@/modules/budget/reporting'
import { ACCOUNTING_NAV } from '../nav'
import { BudgetBoard } from './board'
import { messageFor } from '@/modules/errors'

export const dynamic = 'force-dynamic'

/**
 * Budgets and how the year is going against them (spec §13, Phase 36).
 *
 * Two things on one screen because they are one question. A plan nobody
 * compares to anything is a document; a variance with no plan behind it is not
 * a number. Splitting them across two routes would mean the first thing
 * somebody does after writing a budget is navigate.
 */
export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ b?: string; year?: string; from?: string; to?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Budgets</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const params = await searchParams
  const thisYear = new Date().getFullYear()
  const fiscalYear = Number(params.year) || thisYear

  const [budgets, accounts] = await Promise.all([listBudgets(actor), listAccounts(actor)])

  const forYear = budgets.filter((row) => row.fiscalYear === fiscalYear)
  const selected =
    forYear.find((row) => row.id === params.b) ??
    forYear.find((row) => row.status === 'approved') ??
    forYear[0] ??
    budgets.find((row) => row.id === params.b) ??
    null

  const grid = selected ? await budgetGrid(actor, selected.id) : null

  // The variance needs `reports:financial`; a bookkeeper can write the plan
  // without being able to read the result against it. Same split as Phase 33.
  const canSeeVariance = can(actor, 'reports:financial')

  const startDate = params.from ?? `${fiscalYear}-01-01`
  const endDate = params.to ?? `${fiscalYear}-12-31`

  let variance: BudgetVsActual | null = null
  let varianceError: string | null = null

  if (canSeeVariance && selected) {
    try {
      variance = await budgetVsActual(actor, {
        fiscalYear,
        budgetId: selected.id,
        startDate,
        endDate,
      })
    } catch (error) {
      varianceError =
        messageFor(error, 'The variance could not be worked out.')
    }
  }

  const approved = await budgetForYear(actor, fiscalYear)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/budgets" />
      <BudgetBoard
        fiscalYear={fiscalYear}
        years={[...new Set([thisYear, thisYear + 1, ...budgets.map((row) => row.fiscalYear)])].sort(
          (a, b) => b - a,
        )}
        budgets={budgets}
        selectedId={selected?.id ?? null}
        approvedId={approved?.id ?? null}
        grid={grid}
        variance={variance}
        varianceError={varianceError}
        startDate={startDate}
        endDate={endDate}
        canSeeVariance={canSeeVariance}
        canPlan={can(actor, 'accounting:journal')}
        accounts={accounts
          .filter((account) =>
            ['revenue', 'cogs', 'expense', 'other_income', 'other_expense'].includes(account.type),
          )
          .map((account) => ({
            id: account.id,
            number: account.number,
            name: account.name,
            type: account.type,
          }))}
      />
    </AppShell>
  )
}
