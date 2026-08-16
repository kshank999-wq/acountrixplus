'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  commitImportAction,
  planImportAction,
  revertImportAction,
  type ActionResult,
} from '@/app/actions/importing'
import {
  IMPORT_KIND_LABELS as KIND_LABELS,
  IMPORT_STEPS as STEPS,
  type ImportKind,
} from '@/modules/importing/vocabulary'
import { formatCents } from '@/lib/money'

type Problem = { row: number; field?: string; message: string; severity: 'error' | 'warning' }

type Plan = {
  headers: string[]
  columns: Record<string, string | null>
  delimiter: string
  rows: Array<{ row: number; action: 'create' | 'update' | 'skip'; problems: Problem[] }>
  fileProblems: Problem[]
  counts: {
    total: number
    willCreate: number
    willUpdate: number
    willSkip: number
    errors: number
    warnings: number
  }
  canCommit: boolean
  blankRowsSkipped: number
  // Trial-balance extras.
  fileDebitCents?: number
  fileCreditCents?: number
  balances?: boolean
  receivableControlCents?: number | null
  payableControlCents?: number | null
  // Open-document extras.
  totalCents?: number
}

type Readiness = {
  openingBalanceEquityCents: number
  isClear: boolean
  receivablesReportedCents: number | null
  receivablesDetailCents: number
  receivablesAgree: boolean
  payablesReportedCents: number | null
  payablesDetailCents: number
  payablesAgree: boolean
  diagnosis: string
}

type Run = {
  id: string
  kind: string
  status: 'committed' | 'reverted'
  fileName: string | null
  rowCount: number
  createdCount: number
  updatedCount: number
  totalCents: number | null
  createdAt: string
  notes: string[]
  blockers: string[]
}

/**
 * The migration wizard.
 *
 * Paste or choose a file, see what it would do, then commit. The preview is
 * the whole point: a plan with a single error will not commit, so the list of
 * problems is the work.
 */
export function ImportWizard({
  readiness,
  runs,
  canImport,
}: {
  readiness: Readiness | null
  runs: Run[]
  canImport: boolean
}) {
  const router = useRouter()
  const [kind, setKind] = useState<ImportKind>('chart_of_accounts')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10))
  const [dateOrder, setDateOrder] = useState<'mdy' | 'dmy'>('mdy')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const step = STEPS.find((entry) => entry.kind === kind)!

  function act(fn: () => Promise<ActionResult<unknown>>, onOk?: (data: unknown) => void) {
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        setNotice(result.message ? { ok: true, text: result.message } : null)
        onOk?.(result.data)
      } else {
        setNotice({ ok: false, text: result.error })
      }
    })
  }

  function preview() {
    setPlan(null)
    act(
      () => planImportAction({ kind, text, dateOrder }),
      (data) => setPlan(data as Plan),
    )
  }

  function commit() {
    act(
      () => commitImportAction({ kind, text, fileName, asOfDate, dateOrder }),
      () => {
        setPlan(null)
        setText('')
        setFileName('')
        router.refresh()
      },
    )
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setText(await file.text())
    setPlan(null)
  }

  const rowProblems = plan?.rows.flatMap((row) => row.problems) ?? []
  const allProblems = [...(plan?.fileProblems ?? []), ...rowProblems]
  const errors = allProblems.filter((problem) => problem.severity === 'error')
  const warnings = allProblems.filter((problem) => problem.severity === 'warning')

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Bring in your books</h2>
        <p className="text-sm text-muted">
          A business that has been trading for years does not start from zero.{' '}
          <span className="text-faint">
            Nothing is imported until all of it can be — one bad row stops the whole file, so you
            never end up with half a customer list and no way to tell which half.
          </span>
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          <p className="whitespace-pre-line">{notice.text}</p>
        </div>
      )}

      {readiness && <ReadinessCard readiness={readiness} />}

      {canImport && (
        <Card title="Import a file" subtitle={step.blurb}>
          <div className="space-y-3 px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {STEPS.map((entry) => (
                <button
                  key={entry.kind}
                  onClick={() => {
                    setKind(entry.kind)
                    setPlan(null)
                  }}
                  className={`chip px-3 py-1.5 text-sm ${
                    kind === entry.kind ? 'bg-brand text-brand-ink' : 'bg-raised text-muted hover:text-ink'
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted">
                <span className="mb-1 block">Choose a file</span>
                <input type="file" accept=".csv,.tsv,.txt" onChange={onFile} className="text-sm" />
              </label>

              {kind === 'trial_balance' && (
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Balances as at</span>
                  <input
                    type="date"
                    value={asOfDate}
                    onChange={(event) => setAsOfDate(event.target.value)}
                    className="field py-1.5 text-sm"
                  />
                </label>
              )}

              {(kind === 'open_invoices' || kind === 'open_bills') && (
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Read numeric dates as</span>
                  <select
                    value={dateOrder}
                    onChange={(event) => {
                      setDateOrder(event.target.value as 'mdy' | 'dmy')
                      setPlan(null)
                    }}
                    className="field py-1.5 text-sm"
                  >
                    <option value="mdy">Month / day / year</option>
                    <option value="dmy">Day / month / year</option>
                  </select>
                </label>
              )}
            </div>

            <label className="block text-xs text-muted">
              <span className="mb-1 block">…or paste the file’s contents</span>
              <textarea
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                  setPlan(null)
                }}
                rows={6}
                spellCheck={false}
                placeholder={'Account #,Account Name,Account Type\n1000,Checking Account,Bank'}
                className="field w-full font-mono text-xs"
              />
            </label>

            <div className="flex items-center gap-2">
              <button className="btn btn-ghost" disabled={pending || !text.trim()} onClick={preview}>
                See what this would do
              </button>
              {plan?.canCommit && (
                <button className="btn btn-primary" disabled={pending} onClick={commit}>
                  Import it
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      {plan && (
        <Card
          title={plan.canCommit ? 'Ready to import' : 'Not ready yet'}
          subtitle={
            plan.canCommit
              ? 'Nothing has been written. Check the figures, then import.'
              : 'Every problem is listed. Fix them in the file and try again — an import goes in whole or not at all.'
          }
        >
          <div className="space-y-3 px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Rows" value={`${plan.counts.total}`} />
              <Stat label="To add" value={`${plan.counts.willCreate}`} />
              <Stat label="To update" value={`${plan.counts.willUpdate}`} />
              <Stat
                label="Problems"
                value={`${plan.counts.errors}`}
                tone={plan.counts.errors > 0 ? 'danger' : undefined}
              />
            </div>

            {plan.balances !== undefined && (
              <p className={`text-sm ${plan.balances ? 'text-success' : 'text-danger'}`}>
                {plan.balances
                  ? `The file foots: ${formatCents(plan.fileDebitCents ?? 0)} of debits against the same in credits.`
                  : 'This trial balance does not balance, so it cannot be an opening position.'}
                {plan.receivableControlCents != null && (
                  <span className="block text-xs text-muted">
                    Receivables of {formatCents(plan.receivableControlCents)} are read from this file
                    but not posted — the open invoices supply them, and this figure is what they will
                    be checked against.
                  </span>
                )}
              </p>
            )}

            {plan.totalCents !== undefined && (
              <p className="text-sm">
                <span className="tnum font-medium">{formatCents(plan.totalCents)}</span>{' '}
                <span className="text-muted">outstanding across {plan.counts.willCreate} documents.</span>
              </p>
            )}

            <p className="text-xs text-faint">
              Read as {plan.delimiter === '\t' ? 'tab' : plan.delimiter}-separated.{' '}
              {plan.blankRowsSkipped > 0 && `${plan.blankRowsSkipped} blank rows ignored. `}
              Columns: {describeMapping(plan.columns)}
            </p>

            {errors.length > 0 && <ProblemList title="Must be fixed" problems={errors} tone="danger" />}
            {warnings.length > 0 && (
              <ProblemList title="Worth a look — these will import anyway" problems={warnings} tone="warning" />
            )}
          </div>
        </Card>
      )}

      <Card title="What has been imported" subtitle="Kept whether or not it was later undone.">
        {runs.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Nothing yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 font-medium">File</th>
                <th className="px-4 py-2 text-right font-medium">Rows</th>
                <th className="px-4 py-2 text-right font-medium">Added</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-line">
                  <td className="px-4 py-1.5 text-muted">{run.createdAt}</td>
                  <td className="px-4 py-1.5">
                    {KIND_LABELS[run.kind] ?? run.kind}
                    {run.status === 'reverted' && (
                      <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">
                        undone
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{run.fileName ?? '—'}</td>
                  <td className="tnum px-4 py-1.5 text-right text-muted">{run.rowCount}</td>
                  <td className="tnum px-4 py-1.5 text-right">{run.createdCount}</td>
                  <td className="px-4 py-1.5 text-right">
                    {canImport && run.status === 'committed' && (
                      run.blockers.length === 0 ? (
                        <button
                          className="btn btn-ghost text-xs text-danger"
                          disabled={pending}
                          onClick={() =>
                            act(() => revertImportAction(run.id), () => router.refresh())
                          }
                        >
                          Undo
                        </button>
                      ) : (
                        <span className="text-xs text-faint" title={run.blockers.join('\n')}>
                          in use
                        </span>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function ReadinessCard({ readiness }: { readiness: Readiness }) {
  return (
    <section
      className={`card px-4 py-3 ${readiness.isClear ? '' : 'border-warning'}`}
      aria-label="Opening balance readiness"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Opening Balance Equity</h3>
        <span
          className={`tnum text-xl font-semibold ${
            readiness.isClear ? 'text-success' : 'text-warning'
          }`}
        >
          {formatCents(readiness.openingBalanceEquityCents)}
        </span>
      </div>

      <p className="mt-1 text-sm text-muted">{readiness.diagnosis}</p>

      {(readiness.receivablesReportedCents !== null || readiness.payablesReportedCents !== null) && (
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1 font-medium" />
              <th className="py-1 text-right font-medium">Trial balance said</th>
              <th className="py-1 text-right font-medium">Detail brought across</th>
            </tr>
          </thead>
          <tbody>
            {readiness.receivablesReportedCents !== null && (
              <tr className={`border-t border-line ${readiness.receivablesAgree ? '' : 'text-warning'}`}>
                <td className="py-1.5">Customers owe</td>
                <td className="tnum py-1.5 text-right">
                  {formatCents(readiness.receivablesReportedCents)}
                </td>
                <td className="tnum py-1.5 text-right">
                  {formatCents(readiness.receivablesDetailCents)}
                </td>
              </tr>
            )}
            {readiness.payablesReportedCents !== null && (
              <tr className={`border-t border-line ${readiness.payablesAgree ? '' : 'text-warning'}`}>
                <td className="py-1.5">You owe suppliers</td>
                <td className="tnum py-1.5 text-right">
                  {formatCents(readiness.payablesReportedCents)}
                </td>
                <td className="tnum py-1.5 text-right">
                  {formatCents(readiness.payablesDetailCents)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  )
}

function ProblemList({
  title,
  problems,
  tone,
}: {
  title: string
  problems: Problem[]
  tone: 'danger' | 'warning'
}) {
  // Four hundred rows missing the same column produce four hundred identical
  // messages. Grouping is what makes the one that says something else visible.
  const grouped = new Map<string, number[]>()
  for (const problem of problems) {
    const rows = grouped.get(problem.message) ?? []
    rows.push(problem.row)
    grouped.set(problem.message, rows)
  }

  return (
    <div>
      {/* Written out rather than interpolated: Tailwind reads class names
          statically, so `text-${tone}` produces no CSS at all and the heading
          silently loses its colour. */}
      <p
        className={`text-xs font-semibold uppercase tracking-wide ${
          tone === 'danger' ? 'text-danger' : 'text-warning'
        }`}
      >
        {title}
      </p>
      <ul className="mt-1 space-y-1 text-sm">
        {[...grouped.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 12)
          .map(([message, rows]) => (
            <li key={message} className="flex gap-2">
              <span className="tnum shrink-0 text-xs text-faint">
                {rows[0] === 0
                  ? 'file'
                  : rows.length === 1
                    ? `row ${rows[0]}`
                    : `${rows.length} rows`}
              </span>
              <span className={tone === 'danger' ? 'text-danger' : 'text-muted'}>{message}</span>
            </li>
          ))}
      </ul>
    </div>
  )
}

function describeMapping(columns: Record<string, string | null>): string {
  const mapped = Object.entries(columns).filter(([, header]) => header)
  if (mapped.length === 0) return 'nothing matched.'
  return mapped.map(([field, header]) => `${header} → ${field}`).join(', ')
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="rounded border border-line px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-lg font-semibold ${tone === 'danger' ? 'text-danger' : ''}`}>
        {value}
      </p>
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}
