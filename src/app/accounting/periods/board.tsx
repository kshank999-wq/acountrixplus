'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  closeFiscalYearAction,
  createRecurringEntryAction,
  reopenFiscalYearAction,
  runRecurringNowAction,
  setRecurringActiveAction,
} from '@/app/actions/accounting-core'
import { postDraftEntryAction, discardDraftEntryAction } from '@/app/actions/operations'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Preview = {
  fiscalYear: number
  closingDate: string
  revenueCents: number
  expenseCents: number
  netIncomeCents: number
  checks: Array<{ severity: 'blocker' | 'warning'; message: string }>
  alreadyClosed: boolean
} | null

type Close = {
  id: string
  fiscalYear: number
  closingDate: string
  netIncomeCents: number
  revenueCents: number
  expenseCents: number
  reopenedAt: string | null
  reopenReason: string | null
}

type StaleClose = {
  fiscalYear: number
  entriesSinceCloseCount: number
  netIncomeDriftCents: number
}

type Template = {
  id: string
  name: string
  cadence: string
  dayOfMonth: number
  autoPost: boolean
  isActive: boolean
  nextRunOn: string
  lastRunOn: string | null
  occurrenceCount: number
  endsOn: string | null
}

type Draft = {
  id: string
  entryNumber: number
  entryDate: string
  memo: string | null
  sourceType: string | null
}

type Account = { id: string; number: string; name: string }

type DraftLine = { chartAccountId: string; side: 'debit' | 'credit'; amount: string; memo: string }

/**
 * Recurring entries and the year-end close.
 *
 * Both are about what may happen without a person watching. A template answers
 * that once, when it is written; a close refuses to be automated at all.
 */
export function PeriodsBoard({
  year,
  closingDate,
  preview,
  stale,
  closes,
  templates,
  drafts,
  accounts,
  canManage,
  canClose,
}: {
  year: number
  closingDate: string
  preview: Preview
  stale: StaleClose[]
  closes: Close[]
  templates: Template[]
  drafts: Draft[]
  accounts: Account[]
  canManage: boolean
  canClose: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [memo, setMemo] = useState('')
  const [cadence, setCadence] = useState<'weekly' | 'monthly' | 'quarterly' | 'annually'>('monthly')
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [autoPost, setAutoPost] = useState(false)
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState<DraftLine[]>([
    { chartAccountId: '', side: 'debit', amount: '', memo: '' },
    { chartAccountId: '', side: 'credit', amount: '', memo: '' },
  ])

  const [reopening, setReopening] = useState<string | null>(null)
  const [reopenReason, setReopenReason] = useState('')

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
        ok: result.ok,
      })
      if (result.ok) {
        setOpen(false)
        setReopening(null)
        setReopenReason('')
        router.refresh()
      }
    })
  }

  const totals = lines.reduce(
    (sum, line) => {
      const cents = Number(line.amount) ? Math.round(Number(line.amount) * 100) : 0
      return line.side === 'debit'
        ? { debits: sum.debits + cents, credits: sum.credits }
        : { debits: sum.debits, credits: sum.credits + cents }
    },
    { debits: 0, credits: 0 },
  )

  const blockers = preview?.checks.filter((check) => check.severity === 'blocker') ?? []
  const warnings = preview?.checks.filter((check) => check.severity === 'warning') ?? []

  return (
    <div className="space-y-4">
      {message && (
        <p className={`card p-3 text-sm ${message.ok ? 'text-positive' : 'text-negative'}`} role="status">
          {message.text}
        </p>
      )}

      {/* Closing does not lock the period, so entries can still land in a
          closed year. Nothing refuses them — but the figures the close froze
          are now wrong, and that used to be silent. */}
      {stale.length > 0 && (
        <div className="card border-warning/40 p-4">
          <h2 className="text-sm font-semibold text-warning">
            {stale.length === 1 ? 'A closed year has' : 'Closed years have'} moved since closing
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {stale.map((row) => (
              <li key={row.fiscalYear}>
                <span className="font-medium">{row.fiscalYear}</span>: {row.entriesSinceCloseCount}{' '}
                {row.entriesSinceCloseCount === 1 ? 'entry' : 'entries'} posted after the close.
                {row.netIncomeDriftCents === 0 ? (
                  <span className="text-muted">
                    {' '}
                    They cancel out, so the transfer to Retained Earnings is still right.
                  </span>
                ) : (
                  <span className="text-muted">
                    {' '}
                    Net income for the year is now {formatCents(row.netIncomeDriftCents)} away from
                    what was transferred to Retained Earnings.
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">
            Not a blocker. Locking the period is the control that stops entries; this only says the
            frozen figures no longer match the books. Reopening and closing again brings them back
            into line.
          </p>
        </div>
      )}

      {/* Proposals waiting on a person. */}
      {drafts.length > 0 && (
        <Card
          title={`${drafts.length} proposed ${drafts.length === 1 ? 'entry' : 'entries'} waiting`}
          subtitle="Balanced and validated, and affecting no report until somebody posts one."
        >
          <ul className="divide-y divide-line">
            {drafts.map((draft) => (
              <li key={draft.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    Entry {draft.entryNumber} — {draft.entryDate}
                    {draft.sourceType && (
                      <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                        {draft.sourceType.replace(/_/g, ' ')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">{draft.memo}</p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      className="btn btn-primary px-2 py-1 text-xs"
                      disabled={pending}
                      onClick={() => act(() => postDraftEntryAction(draft.id))}
                    >
                      Post it
                    </button>
                    <button
                      className="btn px-2 py-1 text-xs"
                      disabled={pending}
                      onClick={() => act(() => discardDraftEntryAction(draft.id))}
                    >
                      Discard
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Recurring templates. */}
      <Card
        title="Recurring entries"
        subtitle="A template plus a clock. Whether an occurrence posts or waits as a draft is the template's decision, made once."
        action={
          canManage ? (
            <div className="flex gap-2">
              <button
                className="btn text-xs"
                disabled={pending}
                onClick={() =>
                  act(() => runRecurringNowAction(new Date().toISOString().slice(0, 10)))
                }
              >
                Run what is due
              </button>
              <button className="btn text-xs" onClick={() => setOpen((value) => !value)}>
                {open ? 'Cancel' : 'New template'}
              </button>
            </div>
          ) : undefined
        }
      >
        {open && canManage && (
          <div className="space-y-2 border-b border-line p-4">
            <div className="flex flex-wrap gap-2">
              <input
                className="field flex-1 min-w-48"
                placeholder="Name, e.g. Monthly rent accrual"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <select
                className="field w-40"
                value={cadence}
                onChange={(event) => setCadence(event.target.value as typeof cadence)}
              >
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
                <option value="quarterly">Every quarter</option>
                <option value="annually">Every year</option>
              </select>
              {cadence !== 'weekly' && (
                <input
                  className="field w-24"
                  type="number"
                  min={1}
                  max={28}
                  value={dayOfMonth}
                  onChange={(event) => setDayOfMonth(event.target.value)}
                  title="Day of month, 1–28"
                />
              )}
              <input
                className="field w-40"
                type="date"
                value={startsOn}
                onChange={(event) => setStartsOn(event.target.value)}
              />
            </div>

            <input
              className="field"
              placeholder="Memo, shown on every entry it produces"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
            />

            <div className="space-y-1.5">
              {lines.map((line, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <select
                    className="field flex-1 min-w-56"
                    value={line.chartAccountId}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row, position) =>
                          position === index
                            ? { ...row, chartAccountId: event.target.value }
                            : row,
                        ),
                      )
                    }
                  >
                    <option value="">Choose an account…</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.number} {account.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="field w-28"
                    value={line.side}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row, position) =>
                          position === index
                            ? { ...row, side: event.target.value as 'debit' | 'credit' }
                            : row,
                        ),
                      )
                    }
                  >
                    <option value="debit">Debit</option>
                    <option value="credit">Credit</option>
                  </select>
                  <input
                    className="field w-32 text-right"
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row, position) =>
                          position === index ? { ...row, amount: event.target.value } : row,
                        ),
                      )
                    }
                  />
                  <button
                    className="btn px-2 py-1 text-xs"
                    onClick={() =>
                      setLines((current) => current.filter((_, position) => position !== index))
                    }
                    aria-label="Remove line"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="btn text-xs"
                onClick={() =>
                  setLines((current) => [
                    ...current,
                    { chartAccountId: '', side: 'debit', amount: '', memo: '' },
                  ])
                }
              >
                Add a line
              </button>
            </div>

            <p
              className={`text-xs ${totals.debits === totals.credits && totals.debits > 0 ? 'text-positive' : 'text-muted'}`}
            >
              {formatCents(totals.debits)} of debits against {formatCents(totals.credits)} of
              credits
              {totals.debits !== totals.credits && ' — these must match before it can be saved.'}
            </p>

            <label className="flex items-start gap-2 rounded-lg border border-line p-3 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={autoPost}
                onChange={(event) => setAutoPost(event.target.checked)}
              />
              <span>
                <span className="font-medium">Post it automatically.</span>{' '}
                <span className="text-muted">
                  Leave this off and each occurrence is a draft somebody reviews. On is right for a
                  figure that never changes, like a rent accrual; off is right for anything that
                  moves, because a template that posts an estimate unattended fills the ledger with
                  numbers nobody checked.
                </span>
              </span>
            </label>

            <button
              className="btn btn-primary text-xs"
              disabled={pending || !name.trim() || totals.debits !== totals.credits}
              onClick={() => {
                let parsed
                try {
                  parsed = lines
                    .filter((line) => line.chartAccountId && line.amount.trim())
                    .map((line) => ({
                      chartAccountId: line.chartAccountId,
                      debitCents: line.side === 'debit' ? parseAmountToCents(line.amount) : 0,
                      creditCents: line.side === 'credit' ? parseAmountToCents(line.amount) : 0,
                    }))
                } catch {
                  setMessage({ text: 'One of those amounts is not valid.', ok: false })
                  return
                }

                act(() =>
                  createRecurringEntryAction({
                    name,
                    memo: memo || undefined,
                    cadence,
                    dayOfMonth: cadence === 'weekly' ? undefined : Number(dayOfMonth),
                    autoPost,
                    startsOn,
                    lines: parsed,
                  }),
                )
              }}
            >
              {pending ? 'Saving…' : 'Save template'}
            </button>
          </div>
        )}

        {templates.length === 0 ? (
          <Empty>No recurring entries.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {template.name}
                    <span
                      className={`ml-2 chip px-2 py-0.5 text-[11px] ${
                        template.autoPost
                          ? 'bg-action/10 text-action'
                          : 'bg-raised text-muted'
                      }`}
                    >
                      {template.autoPost ? 'posts automatically' : 'proposed as a draft'}
                    </span>
                    {!template.isActive && (
                      <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                        paused
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-faint">
                    {template.cadence}
                    {template.cadence !== 'weekly' && ` on day ${template.dayOfMonth}`} · next{' '}
                    {template.nextRunOn} · {template.occurrenceCount} so far
                    {template.endsOn && ` · ends ${template.endsOn}`}
                  </p>
                </div>
                {canManage && (
                  <button
                    className="btn px-2 py-1 text-xs"
                    disabled={pending}
                    onClick={() =>
                      act(() => setRecurringActiveAction(template.id, !template.isActive))
                    }
                  >
                    {template.isActive ? 'Pause' : 'Resume'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* The year-end close. */}
      {canClose && preview && (
        <Card
          title={`Close ${year}`}
          subtitle="Empties revenue and expense into Retained Earnings, so the next year opens from zero. Closing does not lock the period — that is a separate control, on purpose."
        >
          <div className="grid grid-cols-3 gap-3 p-4">
            <Figure label="Revenue" value={formatCents(preview.revenueCents)} />
            <Figure label="Expenses" value={formatCents(preview.expenseCents)} />
            <Figure
              label={preview.netIncomeCents >= 0 ? 'Net income' : 'Net loss'}
              value={formatCents(Math.abs(preview.netIncomeCents))}
              accent
            />
          </div>

          {preview.checks.length > 0 && (
            <ul className="border-t border-line">
              {preview.checks.map((check, index) => (
                <li key={index} className="flex gap-3 border-t border-line px-4 py-2 text-sm first:border-t-0">
                  <span
                    className={`chip mt-0.5 h-fit shrink-0 px-2 py-0.5 text-[11px] ${
                      check.severity === 'blocker'
                        ? 'bg-negative/15 text-negative'
                        : 'bg-warning/15 text-warning'
                    }`}
                  >
                    {check.severity === 'blocker' ? 'Blocker' : 'Check'}
                  </span>
                  <span>{check.message}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-line p-4">
            <button
              className="btn btn-primary text-xs"
              disabled={pending || blockers.length > 0}
              onClick={() => act(() => closeFiscalYearAction(closingDate))}
            >
              {pending ? 'Closing…' : `Close ${year}`}
            </button>
            {blockers.length > 0 && (
              <p className="mt-2 text-xs text-negative">
                Blocked. Unlike a tax filing there is no override — closing a year twice has one
                outcome and it is wrong.
              </p>
            )}
            {warnings.length > 0 && blockers.length === 0 && (
              <p className="mt-2 text-xs text-warning">
                Worth checking first, but nothing here stops the close.
              </p>
            )}
          </div>
        </Card>
      )}

      {closes.length > 0 && (
        <Card title="Closed years" subtitle="Reopening reverses the entry rather than deleting it.">
          <ul className="divide-y divide-line">
            {closes.map((close) => (
              <li key={close.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {close.fiscalYear}
                      {close.reopenedAt && (
                        <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                          reopened
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-faint">
                      {formatCents(close.revenueCents)} revenue, {formatCents(close.expenseCents)}{' '}
                      expenses, {formatCents(close.netIncomeCents)} to Retained Earnings
                      {close.reopenReason && ` · reopened: ${close.reopenReason}`}
                    </p>
                  </div>
                  {canClose && !close.reopenedAt && (
                    <button
                      className="btn px-2 py-1 text-xs"
                      onClick={() => setReopening(reopening === close.id ? null : close.id)}
                    >
                      Reopen
                    </button>
                  )}
                </div>

                {reopening === close.id && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input
                      className="field flex-1 min-w-64"
                      placeholder="Why is the year being reopened?"
                      value={reopenReason}
                      onChange={(event) => setReopenReason(event.target.value)}
                    />
                    <button
                      className="btn btn-primary px-2 py-1 text-xs"
                      disabled={pending || !reopenReason.trim()}
                      onClick={() => act(() => reopenFiscalYearAction(close.id, reopenReason))}
                    >
                      Reopen it
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Figure({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${accent ? 'text-action' : ''}`}>{value}</p>
    </div>
  )
}

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}
