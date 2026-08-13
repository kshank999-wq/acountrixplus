'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  acceptSuggestionAction,
  bulkCategorizeAction,
  categorizeAction,
  undoAction,
} from '@/app/actions/bookkeeping'
import { TransactionDetail } from './transaction-detail'

export type InboxRow = {
  id: string
  postedDate: string
  amountCents: number
  description: string
  merchantName: string | null
  providerCategory: string | null
  pending: boolean
  reviewState: string
  chartAccountId: string | null
  chartAccountName: string | null
  chartAccountNumber: string | null
  appliedRuleId: string | null
  isSplit: boolean
  isTransfer: boolean
  notes: string | null
  financialAccountId: string
  financialAccountName: string
  financialAccountMask: string | null
}

export type AccountOption = { id: string; number: string; name: string }

type Props = {
  rows: InboxRow[]
  total: number
  page: number
  pageSize: number
  counts: Record<string, number>
  accounts: AccountOption[]
  financialAccounts: Array<{ id: string; name: string; mask: string | null }>
  filters: { q: string; account: string; state: string }
  canEdit: boolean
  canManageRules: boolean
  /** Whether the AI module is switched on for this company (spec §11). */
  aiEnabled: boolean
}

const STATE_TABS = [
  { key: 'unreviewed', label: 'To review' },
  { key: 'categorized', label: 'Categorized' },
  { key: 'excluded', label: 'Excluded' },
  { key: 'matched', label: 'Transfers' },
] as const

/** Review-state badge colours. */
const STATE_STYLES: Record<string, string> = {
  new: 'bg-raised text-muted',
  suggested: 'bg-warning/15 text-warning',
  needs_review: 'bg-warning/15 text-warning',
  categorized: 'bg-positive/15 text-positive',
  matched: 'bg-brand/15 text-brand',
  excluded: 'bg-raised text-faint',
  reconciled: 'bg-brand/15 text-brand',
}

export function Inbox(props: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)
  const [bulkAccount, setBulkAccount] = useState('')
  const [rememberVendor, setRememberVendor] = useState(true)

  const unreviewedCount = useMemo(
    () => (props.counts.new ?? 0) + (props.counts.suggested ?? 0) + (props.counts.needs_review ?? 0),
    [props.counts],
  )

  function notify(result: { ok: boolean; message?: string; error?: string }) {
    setToast({
      text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
      ok: result.ok,
    })
    setTimeout(() => setToast(null), 5000)
  }

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    // Any filter change invalidates the current page offset.
    next.delete('page')
    router.push(`/bookkeeping?${next.toString()}`)
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((current) =>
      current.size === props.rows.length ? new Set() : new Set(props.rows.map((r) => r.id)),
    )
  }

  function categorizeOne(id: string, chartAccountId: string) {
    if (!chartAccountId) return
    startTransition(async () => {
      const result = await categorizeAction(id, chartAccountId, rememberVendor)
      notify(result)
      router.refresh()
    })
  }

  function acceptOne(id: string) {
    startTransition(async () => {
      const result = await acceptSuggestionAction(id)
      notify(result)
      router.refresh()
    })
  }

  function applyBulk() {
    if (!bulkAccount || selected.size === 0) return
    startTransition(async () => {
      const result = await bulkCategorizeAction([...selected], bulkAccount)
      notify(result)
      setSelected(new Set())
      setBulkAccount('')
      router.refresh()
    })
  }

  function undo() {
    startTransition(async () => {
      const result = await undoAction()
      notify(result)
      router.refresh()
    })
  }

  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize))

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="To review" value={unreviewedCount} accent />
        <SummaryCard label="Suggested" value={props.counts.suggested ?? 0} />
        <SummaryCard label="Categorized" value={props.counts.categorized ?? 0} />
        <SummaryCard label="Excluded" value={props.counts.excluded ?? 0} />
      </div>

      {/* Filters */}
      <div className="card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 basis-full gap-2 sm:basis-auto">
            <input
              type="search"
              defaultValue={props.filters.q}
              placeholder="Search description or merchant…"
              className="field"
              onKeyDown={(event) => {
                if (event.key === 'Enter') setParam('q', event.currentTarget.value)
              }}
              aria-label="Search transactions"
            />
          </div>

          <select
            value={props.filters.account}
            onChange={(event) => setParam('account', event.target.value)}
            className="field w-auto"
            aria-label="Filter by bank account"
          >
            <option value="">All accounts</option>
            {props.financialAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
                {account.mask ? ` ····${account.mask}` : ''}
              </option>
            ))}
          </select>

          {props.canEdit && (
            <button onClick={undo} disabled={pending} className="btn text-xs">
              Undo last
            </button>
          )}
        </div>

        <div className="mt-3 flex gap-1 overflow-x-auto">
          {STATE_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setParam('state', tab.key === 'unreviewed' ? '' : tab.key)}
              className={`chip whitespace-nowrap px-3 py-1.5 ${
                props.filters.state === tab.key
                  ? 'bg-brand text-brand-ink'
                  : 'bg-raised text-muted hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {props.canEdit && selected.size > 0 && (
        <div className="sticky top-16 z-10 card flex flex-wrap items-center gap-2 border-brand/40 bg-raised p-3">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <select
            value={bulkAccount}
            onChange={(event) => setBulkAccount(event.target.value)}
            className="field w-auto flex-1 sm:flex-none"
            aria-label="Category for selected transactions"
          >
            <option value="">Choose a category…</option>
            {props.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.number} · {account.name}
              </option>
            ))}
          </select>
          <button
            onClick={applyBulk}
            disabled={!bulkAccount || pending}
            className="btn btn-primary text-xs"
          >
            Categorize {selected.size}
          </button>
          <button onClick={() => setSelected(new Set())} className="btn text-xs">
            Clear
          </button>
        </div>
      )}

      {props.canEdit && (
        <label className="flex items-center gap-2 px-1 text-xs text-muted">
          <input
            type="checkbox"
            checked={rememberVendor}
            onChange={(event) => setRememberVendor(event.target.checked)}
            className="rounded border-line"
          />
          Remember this vendor and suggest the same category next time
        </label>
      )}

      {/* Transactions */}
      {props.rows.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm font-medium">Nothing to review</p>
          <p className="mt-1 text-sm text-muted">
            Sync your bank feed to pull in transactions.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          {/* Desktop table */}
          <table className="hidden w-full text-sm md:table">
            <thead className="border-b border-line bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-10 px-3 py-2">
                  {props.canEdit && (
                    <input
                      type="checkbox"
                      checked={selected.size === props.rows.length && props.rows.length > 0}
                      onChange={toggleAll}
                      className="rounded border-line"
                      aria-label="Select all transactions"
                    />
                  )}
                </th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <RowGroup
                  key={row.id}
                  row={row}
                  variant="desktop"
                  selected={selected.has(row.id)}
                  expanded={expandedId === row.id}
                  accounts={props.accounts}
                  canEdit={props.canEdit}
                  canManageRules={props.canManageRules}
                  aiEnabled={props.aiEnabled}
                  pending={pending}
                  onToggle={() => toggle(row.id)}
                  onExpand={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  onCategorize={(accountId) => categorizeOne(row.id, accountId)}
                  onAccept={() => acceptOne(row.id)}
                  onResult={notify}
                />
              ))}
            </tbody>
          </table>

          {/* Mobile cards — spec §3 calls for rapid review on a phone. */}
          <ul className="divide-y divide-line md:hidden">
            {props.rows.map((row) => (
              <RowGroup
                key={row.id}
                row={row}
                variant="mobile"
                selected={selected.has(row.id)}
                expanded={expandedId === row.id}
                accounts={props.accounts}
                canEdit={props.canEdit}
                canManageRules={props.canManageRules}
                aiEnabled={props.aiEnabled}
                pending={pending}
                onToggle={() => toggle(row.id)}
                onExpand={() => setExpandedId(expandedId === row.id ? null : row.id)}
                onCategorize={(accountId) => categorizeOne(row.id, accountId)}
                onAccept={() => acceptOne(row.id)}
                onResult={notify}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">
            Page {props.page} of {totalPages} · {props.total} transactions
          </span>
          <div className="flex gap-2">
            <button
              className="btn text-xs"
              disabled={props.page <= 1}
              onClick={() => setParam('page', String(props.page - 1))}
            >
              Previous
            </button>
            <button
              className="btn text-xs"
              disabled={props.page >= totalPages}
              onClick={() => setParam('page', String(props.page + 1))}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-lg ${
            toast.ok
              ? 'border-positive/40 bg-surface text-positive'
              : 'border-negative/40 bg-surface text-negative'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: boolean
}) {
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-2xl font-semibold ${accent ? 'text-brand' : ''}`}>{value}</p>
    </div>
  )
}

type RowProps = {
  row: InboxRow
  variant: 'desktop' | 'mobile'
  selected: boolean
  expanded: boolean
  accounts: AccountOption[]
  canEdit: boolean
  canManageRules: boolean
  aiEnabled: boolean
  pending: boolean
  onToggle: () => void
  onExpand: () => void
  onCategorize: (chartAccountId: string) => void
  onAccept: () => void
  onResult: (result: { ok: boolean; message?: string; error?: string }) => void
}

function RowGroup(props: RowProps) {
  const { row } = props
  const isCredit = row.amountCents >= 0

  const amount = (
    <span className={`tnum font-medium ${isCredit ? 'text-positive' : ''}`}>
      {formatCents(row.amountCents)}
    </span>
  )

  const stateBadge = (
    <span className={`chip ${STATE_STYLES[row.reviewState] ?? 'bg-raised text-muted'}`}>
      {row.reviewState.replace('_', ' ')}
    </span>
  )

  const categoryControl = props.canEdit ? (
    <select
      value={row.chartAccountId ?? ''}
      disabled={props.pending}
      onChange={(event) => props.onCategorize(event.target.value)}
      className="field py-1.5 text-xs"
      aria-label={`Category for ${row.description}`}
    >
      <option value="">
        {row.isSplit ? '— Split —' : 'Uncategorized'}
      </option>
      {props.accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.number} · {account.name}
        </option>
      ))}
    </select>
  ) : (
    <span className="text-xs text-muted">
      {row.isSplit ? 'Split' : (row.chartAccountName ?? 'Uncategorized')}
    </span>
  )

  const detail = props.expanded && (
    <TransactionDetail
      row={row}
      accounts={props.accounts}
      canEdit={props.canEdit}
      canManageRules={props.canManageRules}
      aiEnabled={props.aiEnabled}
      onResult={props.onResult}
    />
  )

  if (props.variant === 'desktop') {
    return (
      <>
        <tr className="border-b border-line last:border-0 hover:bg-raised/40">
          <td className="px-3 py-2 align-middle">
            {props.canEdit && (
              <input
                type="checkbox"
                checked={props.selected}
                onChange={props.onToggle}
                className="rounded border-line"
                aria-label={`Select ${row.description}`}
              />
            )}
          </td>
          <td className="tnum whitespace-nowrap px-3 py-2 align-middle text-xs text-muted">
            {row.postedDate}
          </td>
          <td className="px-3 py-2 align-middle">
            <div className="flex items-center gap-2">
              <span className="font-medium">{row.merchantName ?? row.description}</span>
              {row.pending && <span className="chip bg-raised text-faint">pending</span>}
              {row.isTransfer && <span className="chip bg-brand/15 text-brand">transfer</span>}
            </div>
            <p className="truncate text-xs text-faint">
              {row.description} · {row.financialAccountName}
            </p>
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-right align-middle">{amount}</td>
          <td className="px-3 py-2 align-middle">
            <div className="flex items-center gap-2">
              <div className="min-w-[12rem]">{categoryControl}</div>
              {row.reviewState === 'suggested' && props.canEdit && (
                <button onClick={props.onAccept} className="btn px-2 py-1 text-xs">
                  Accept
                </button>
              )}
            </div>
          </td>
          <td className="px-3 py-2 text-right align-middle">
            <button
              onClick={props.onExpand}
              className="btn px-2 py-1 text-xs"
              aria-expanded={props.expanded}
            >
              {props.expanded ? 'Close' : 'More'}
            </button>
          </td>
        </tr>
        {props.expanded && (
          <tr className="border-b border-line bg-raised/30">
            <td colSpan={6} className="px-3 py-3">
              {detail}
            </td>
          </tr>
        )}
      </>
    )
  }

  return (
    <li className="p-3">
      <div className="flex items-start gap-3">
        {props.canEdit && (
          <input
            type="checkbox"
            checked={props.selected}
            onChange={props.onToggle}
            className="mt-1 h-5 w-5 rounded border-line"
            aria-label={`Select ${row.description}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{row.merchantName ?? row.description}</span>
            {amount}
          </div>
          <p className="mt-0.5 truncate text-xs text-faint">
            {row.postedDate} · {row.financialAccountName}
          </p>

          <div className="mt-2 flex items-center gap-2">
            {stateBadge}
            {row.pending && <span className="chip bg-raised text-faint">pending</span>}
          </div>

          <div className="mt-2">{categoryControl}</div>

          <div className="mt-2 flex gap-2">
            {row.reviewState === 'suggested' && props.canEdit && (
              <button onClick={props.onAccept} className="btn flex-1 py-2 text-xs">
                Accept suggestion
              </button>
            )}
            <button onClick={props.onExpand} className="btn flex-1 py-2 text-xs">
              {props.expanded ? 'Close' : 'More actions'}
            </button>
          </div>

          {props.expanded && <div className="mt-3">{detail}</div>}
        </div>
      </div>
    </li>
  )
}
