'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  approveBudgetAction,
  clearAccountBudgetAction,
  copyFromActualsAction,
  createBudgetAction,
  setAccountBudgetAction,
  type ActionResult,
} from '@/app/actions/budget'
import { formatCents } from '@/lib/money'

type BudgetRow = {
  id: string
  name: string
  fiscalYear: number
  status: 'draft' | 'approved' | 'archived'
  notes: string | null
  lineCount: number
  totalCents: number
}

type Grid = {
  budget: { id: string; name: string; fiscalYear: number; status: string }
  rows: Array<{
    chartAccountId: string
    number: string
    name: string
    type: string
    monthlyCents: number[]
    totalCents: number
  }>
  incomeMonthlyCents: number[]
  costMonthlyCents: number[]
  netMonthlyCents: number[]
  incomeCents: number
  costCents: number
  netCents: number
}

type VarianceRow = {
  chartAccountId: string
  number: string
  name: string
  budgetCents: number
  actualCents: number
  varianceCents: number
  favourable: boolean
  basisPoints: number | null
}

type Section = {
  title: string
  rows: VarianceRow[]
  budgetCents: number
  actualCents: number
  varianceCents: number
  favourable: boolean
}

type Variance = {
  budget: { id: string; name: string; fiscalYear: number; status: string }
  basis: string
  startDate: string
  endDate: string
  months: number[]
  revenue: Section
  costOfSales: Section
  operatingExpenses: Section
  otherIncome: Section
  otherExpenses: Section
  netIncome: {
    budgetCents: number
    actualCents: number
    varianceCents: number
    favourable: boolean
    basisPoints: number | null
  }
  unbudgeted: Array<{ number: string; name: string; type: string; actualCents: number }>
  unbudgetedIncomeCents: number
  unbudgetedCostCents: number
  unbudgetedNetCents: number
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** A percentage from basis points, or a dash when there is nothing to be a share of. */
function percent(basisPoints: number | null): string {
  if (basisPoints === null) return '—'
  const value = basisPoints / 100
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

/**
 * The plan, and how the year is going against it.
 *
 * ## Favourable and adverse, not plus and minus
 *
 * Every variance on this screen is coloured and labelled by whether it *helps*,
 * not by its sign. Revenue $100 under plan and rent $50 under plan are both
 * negative numbers and opposite kinds of news, and making somebody work that
 * out row by row is the job this screen exists to do for them.
 */
export function BudgetBoard({
  fiscalYear,
  years,
  budgets,
  selectedId,
  approvedId,
  grid,
  variance,
  varianceError,
  startDate,
  endDate,
  canSeeVariance,
  canPlan,
  accounts,
}: {
  fiscalYear: number
  years: number[]
  budgets: BudgetRow[]
  selectedId: string | null
  approvedId: string | null
  grid: Grid | null
  variance: Variance | null
  varianceError: string | null
  startDate: string
  endDate: string
  canSeeVariance: boolean
  canPlan: boolean
  accounts: Array<{ id: string; number: string; name: string; type: string }>
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const [newName, setNewName] = useState(`${fiscalYear} Approved`)
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [annual, setAnnual] = useState('')
  const [sourceYear, setSourceYear] = useState(String(fiscalYear - 1))
  const [uplift, setUplift] = useState('0')

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error },
      )
      if (result.ok) router.refresh()
    })
  }

  function go(next: Record<string, string>) {
    const params = new URLSearchParams({
      year: String(fiscalYear),
      ...(selectedId ? { b: selectedId } : {}),
      from: startDate,
      to: endDate,
      ...next,
    })
    router.push(`/accounting/budgets?${params.toString()}`)
  }

  const forYear = budgets.filter((row) => row.fiscalYear === fiscalYear)

  const sections = variance
    ? ([
        variance.revenue,
        variance.costOfSales,
        variance.operatingExpenses,
        variance.otherIncome,
        variance.otherExpenses,
      ].filter((section) => section.rows.length > 0) as Section[])
    : []

  function verdict(favourable: boolean, cents: number) {
    if (cents === 0) return <span className="text-muted">on plan</span>
    return (
      <span className={favourable ? 'text-success' : 'text-danger'}>
        {favourable ? 'favourable' : 'adverse'}
      </span>
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Budgets</h2>
        <p className="text-sm text-muted">
          What the business planned to earn and spend, and how the year is going against it.{' '}
          <span className="text-faint">
            Nothing here posts to the ledger. A budget that posted would appear in the actuals it
            exists to be compared against.
          </span>
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      <div className="card flex flex-wrap items-end gap-3 px-4 py-3">
        <label className="text-xs text-muted">
          <span className="mb-1 block">Year</span>
          <select
            value={fiscalYear}
            onChange={(event) => go({ year: event.target.value, b: '', from: '', to: '' })}
            className="field py-1.5 text-sm"
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>

        {forYear.length > 0 && (
          <label className="text-xs text-muted">
            <span className="mb-1 block">Budget</span>
            <select
              value={selectedId ?? ''}
              onChange={(event) => go({ b: event.target.value })}
              className="field py-1.5 text-sm"
            >
              {forYear.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.id === approvedId ? ' (approved)' : row.status === 'archived' ? ' (archived)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {canSeeVariance && selectedId && (
          <>
            <label className="text-xs text-muted">
              <span className="mb-1 block">From</span>
              <input
                type="date"
                value={startDate}
                onChange={(event) => go({ from: event.target.value })}
                className="field py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">To</span>
              <input
                type="date"
                value={endDate}
                onChange={(event) => go({ to: event.target.value })}
                className="field py-1.5 text-sm"
              />
            </label>
          </>
        )}

        {canPlan && (
          <div className="ml-auto flex items-end gap-2">
            <label className="text-xs text-muted">
              <span className="mb-1 block">New budget</span>
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={`${fiscalYear} Approved`}
                className="field w-48 py-1.5 text-sm"
              />
            </label>
            <button
              type="button"
              disabled={pending || !newName.trim()}
              onClick={() =>
                act(() => createBudgetAction({ name: newName.trim(), fiscalYear }))
              }
              className="btn btn-secondary py-1.5 text-sm"
            >
              Create
            </button>
          </div>
        )}
      </div>

      {forYear.length === 0 ? (
        <section className="card px-4 py-8 text-center">
          <h3 className="text-sm font-semibold">No budget for {fiscalYear}</h3>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted">
            Create one above, then either type an annual figure per account or fill it in from last
            year’s actuals — which keeps the seasonality, and is the commonest way a budget gets
            built without anybody retyping twelve numbers.
          </p>
        </section>
      ) : (
        <>
          {canSeeVariance && selectedId && (
            <section className="card px-4 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    How it is going against “{grid?.budget.name}”
                  </h3>
                  <p className="mt-1 text-xs text-muted">
                    {variance
                      ? `${variance.months.length} whole month${
                          variance.months.length === 1 ? '' : 's'
                        } compared. Part months are left out — a business does not earn its February evenly.`
                      : 'Nothing to compare yet.'}
                  </p>
                </div>
              </div>

              {varianceError ? (
                <p className="mt-3 text-sm text-danger">{varianceError}</p>
              ) : !variance ? null : (
                <div className="mt-3 space-y-5">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted">
                        <tr className="border-b border-line text-left">
                          <th className="py-1.5 pr-3">Account</th>
                          <th className="py-1.5 pr-3 text-right">Plan</th>
                          <th className="py-1.5 pr-3 text-right">Actual</th>
                          <th className="py-1.5 pr-3 text-right">Difference</th>
                          <th className="py-1.5 pr-3 text-right">%</th>
                          <th className="py-1.5">Reading</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sections.map((section) => (
                          // Keyed on the fragment, not the rows inside it: a
                          // key on a child of a fragment is a key React never
                          // sees.
                          <Fragment key={section.title}>
                            <tr className="border-b border-line/50">
                              <td
                                className="py-1.5 pr-3 pt-3 text-xs font-semibold uppercase tracking-wide text-muted"
                                colSpan={6}
                              >
                                {section.title}
                              </td>
                            </tr>
                            {section.rows.map((row) => (
                              <tr
                                key={row.chartAccountId}
                                className="border-b border-line/50"
                              >
                                <td className="py-1.5 pr-3 pl-3">
                                  <span className="text-muted">{row.number}</span> {row.name}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">
                                  {formatCents(row.budgetCents)}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">
                                  {formatCents(row.actualCents)}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">
                                  {formatCents(row.varianceCents)}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                                  {percent(row.basisPoints)}
                                </td>
                                <td className="py-1.5">
                                  {verdict(row.favourable, row.varianceCents)}
                                </td>
                              </tr>
                            ))}
                            <tr className="border-b border-line font-medium">
                              <td className="py-1.5 pr-3 pl-3">Total {section.title.toLowerCase()}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">
                                {formatCents(section.budgetCents)}
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">
                                {formatCents(section.actualCents)}
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">
                                {formatCents(section.varianceCents)}
                              </td>
                              <td className="py-1.5" />
                              <td className="py-1.5">
                                {verdict(section.favourable, section.varianceCents)}
                              </td>
                            </tr>
                          </Fragment>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="font-semibold">
                          <td className="py-2 pr-3">Net income</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatCents(variance.netIncome.budgetCents)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatCents(variance.netIncome.actualCents)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatCents(variance.netIncome.varianceCents)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-muted">
                            {percent(variance.netIncome.basisPoints)}
                          </td>
                          <td className="py-2">
                            {verdict(
                              variance.netIncome.favourable,
                              variance.netIncome.varianceCents,
                            )}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {variance.unbudgeted.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                        Not budgeted at all
                      </h4>
                      <p className="mt-1 text-xs text-faint">
                        Activity on accounts the plan never mentioned. Deliberately shown apart and
                        given no variance: there is no plan to vary from, and reporting these as
                        “100% over” would bury them among the rows that merely drifted. Net income
                        above includes them.
                      </p>
                      <p className="mt-2 text-sm">
                        <span className="text-muted">Unplanned income</span>{' '}
                        <span className="tabular-nums">
                          {formatCents(variance.unbudgetedIncomeCents)}
                        </span>
                        <span className="text-faint"> · </span>
                        <span className="text-muted">unplanned cost</span>{' '}
                        <span className="tabular-nums">
                          {formatCents(variance.unbudgetedCostCents)}
                        </span>
                        <span className="text-faint"> · </span>
                        <span className="text-muted">net effect on the result</span>{' '}
                        <span
                          className={`tabular-nums ${
                            variance.unbudgetedNetCents >= 0 ? 'text-success' : 'text-danger'
                          }`}
                        >
                          {formatCents(variance.unbudgetedNetCents)}
                        </span>
                      </p>
                      <ul className="mt-2 space-y-1 text-sm">
                        {variance.unbudgeted.map((row) => (
                          <li key={row.number} className="text-muted">
                            <span className="font-medium text-ink">{row.number}</span> {row.name} —{' '}
                            <span className="tabular-nums">{formatCents(row.actualCents)}</span>
                            <span className="text-faint">
                              {' '}
                              {row.type === 'revenue' || row.type === 'other_income'
                                ? 'income'
                                : 'cost'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {canPlan && selectedId && (
            <section className="card px-4 py-4">
              <h3 className="text-sm font-semibold">Fill the plan in</h3>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Account</span>
                  <select
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                    className="field py-1.5 text-sm"
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.number} {account.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  <span className="mb-1 block">For the year</span>
                  <input
                    value={annual}
                    onChange={(event) => setAnnual(event.target.value)}
                    placeholder="120,000.00"
                    inputMode="decimal"
                    className="field w-36 py-1.5 text-sm"
                  />
                </label>
                <button
                  type="button"
                  disabled={pending || !accountId || !annual.trim()}
                  onClick={() =>
                    act(() =>
                      setAccountBudgetAction({
                        budgetId: selectedId,
                        chartAccountId: accountId,
                        annual,
                      }),
                    )
                  }
                  className="btn btn-primary py-1.5 text-sm"
                >
                  Spread across the year
                </button>
                <button
                  type="button"
                  disabled={pending || !accountId}
                  onClick={() =>
                    act(() =>
                      clearAccountBudgetAction({
                        budgetId: selectedId,
                        chartAccountId: accountId,
                      }),
                    )
                  }
                  className="btn btn-secondary py-1.5 text-sm"
                >
                  Remove from plan
                </button>
              </div>

              <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
                <div className="w-full text-xs text-muted">
                  Or fill it in from a year that already happened. Month by month, so the
                  seasonality survives — a business that does half its trade in December should not
                  be planned in twelfths.
                </div>
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Copy actuals from</span>
                  <input
                    value={sourceYear}
                    onChange={(event) => setSourceYear(event.target.value)}
                    inputMode="numeric"
                    className="field w-24 py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Uplift %</span>
                  <input
                    value={uplift}
                    onChange={(event) => setUplift(event.target.value)}
                    inputMode="decimal"
                    className="field w-24 py-1.5 text-sm"
                  />
                </label>
                <button
                  type="button"
                  disabled={pending || !sourceYear.trim()}
                  onClick={() =>
                    act(() =>
                      copyFromActualsAction({
                        budgetId: selectedId,
                        sourceYear: Number(sourceYear),
                        upliftBasisPoints: Math.round(Number(uplift || 0) * 100),
                      }),
                    )
                  }
                  className="btn btn-secondary py-1.5 text-sm"
                >
                  Copy
                </button>

                {selectedId !== approvedId && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => act(() => approveBudgetAction({ budgetId: selectedId }))}
                    className="btn btn-primary ml-auto py-1.5 text-sm"
                  >
                    Approve this budget
                  </button>
                )}
              </div>
            </section>
          )}

          {grid && grid.rows.length > 0 && (
            <section className="card px-4 py-4">
              <h3 className="text-sm font-semibold">The plan, month by month</h3>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line text-left">
                      <th className="py-1.5 pr-3">Account</th>
                      {MONTH_LABELS.map((label) => (
                        <th key={label} className="py-1.5 pr-2 text-right">
                          {label}
                        </th>
                      ))}
                      <th className="py-1.5 text-right">Year</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grid.rows.map((row) => (
                      <tr key={row.chartAccountId} className="border-b border-line/50">
                        <td className="whitespace-nowrap py-1.5 pr-3">
                          <span className="text-muted">{row.number}</span> {row.name}
                        </td>
                        {row.monthlyCents.map((cents, index) => (
                          <td
                            key={index}
                            className="py-1.5 pr-2 text-right tabular-nums text-muted"
                          >
                            {formatCents(cents)}
                          </td>
                        ))}
                        <td className="py-1.5 text-right tabular-nums font-medium">
                          {formatCents(row.totalCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {/* Income and cost never summed together. A single "Total"
                        row would add planned revenue to planned rent, which is
                        the mistake this whole phase argues against. */}
                    <tr className="text-muted">
                      <td className="py-1.5 pr-3">Planned income</td>
                      {grid.incomeMonthlyCents.map((cents, index) => (
                        <td key={index} className="py-1.5 pr-2 text-right tabular-nums">
                          {formatCents(cents)}
                        </td>
                      ))}
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(grid.incomeCents)}
                      </td>
                    </tr>
                    <tr className="text-muted">
                      <td className="py-1.5 pr-3">Planned cost</td>
                      {grid.costMonthlyCents.map((cents, index) => (
                        <td key={index} className="py-1.5 pr-2 text-right tabular-nums">
                          {formatCents(cents)}
                        </td>
                      ))}
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(grid.costCents)}
                      </td>
                    </tr>
                    <tr className="font-medium">
                      <td className="py-1.5 pr-3">Planned result</td>
                      {grid.netMonthlyCents.map((cents, index) => (
                        <td key={index} className="py-1.5 pr-2 text-right tabular-nums">
                          {formatCents(cents)}
                        </td>
                      ))}
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(grid.netCents)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
