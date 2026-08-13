'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  createRuleAction,
  excludeAction,
  markTransferAction,
  noteAction,
  splitAction,
} from '@/app/actions/bookkeeping'
import type { AccountOption, InboxRow } from './inbox'

type Props = {
  row: InboxRow
  accounts: AccountOption[]
  canEdit: boolean
  canManageRules: boolean
  onResult: (result: { ok: boolean; message?: string; error?: string }) => void
}

type Tab = 'split' | 'rule' | 'other'

/**
 * The per-transaction action panel: split, exclude, mark as transfer, note,
 * and create a rule from this transaction (spec §3).
 */
export function TransactionDetail(props: Props) {
  const [tab, setTab] = useState<Tab>('split')

  if (!props.canEdit) {
    return (
      <p className="text-xs text-muted">
        Your role can view these transactions but not change them.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <TabButton active={tab === 'split'} onClick={() => setTab('split')}>
          Split
        </TabButton>
        {props.canManageRules && (
          <TabButton active={tab === 'rule'} onClick={() => setTab('rule')}>
            Create rule
          </TabButton>
        )}
        <TabButton active={tab === 'other'} onClick={() => setTab('other')}>
          Exclude · Transfer · Note
        </TabButton>
      </div>

      {tab === 'split' && <SplitPanel {...props} />}
      {tab === 'rule' && props.canManageRules && <RulePanel {...props} />}
      {tab === 'other' && <OtherPanel {...props} />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`chip px-3 py-1.5 ${active ? 'bg-brand text-brand-ink' : 'bg-raised text-muted hover:text-ink'}`}
    >
      {children}
    </button>
  )
}

/** Split editor. Shows the running remainder so the lines must reach zero. */
function SplitPanel({ row, accounts, onResult }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [lines, setLines] = useState([
    { chartAccountId: '', amount: '', memo: '' },
    { chartAccountId: '', amount: '', memo: '' },
  ])

  const entered = lines.reduce((sum, line) => {
    const value = Number(line.amount.replace(/[$,\s]/g, ''))
    return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0)
  }, 0)
  const remainder = row.amountCents - entered

  function update(index: number, patch: Partial<(typeof lines)[number]>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  function submit() {
    startTransition(async () => {
      const result = await splitAction(row.id, lines)
      onResult(result)
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Splitting {formatCents(row.amountCents)}. Use negative amounts for spending.
      </p>

      {lines.map((line, index) => (
        <div key={index} className="flex flex-wrap gap-2">
          <select
            value={line.chartAccountId}
            onChange={(event) => update(index, { chartAccountId: event.target.value })}
            className="field flex-1 py-1.5 text-xs"
            aria-label={`Split line ${index + 1} account`}
          >
            <option value="">Choose an account…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.number} · {account.name}
              </option>
            ))}
          </select>
          <input
            value={line.amount}
            onChange={(event) => update(index, { amount: event.target.value })}
            placeholder="-00.00"
            inputMode="decimal"
            className="field w-28 py-1.5 text-xs"
            aria-label={`Split line ${index + 1} amount`}
          />
          <input
            value={line.memo}
            onChange={(event) => update(index, { memo: event.target.value })}
            placeholder="Memo (optional)"
            className="field w-full py-1.5 text-xs sm:w-40"
            aria-label={`Split line ${index + 1} memo`}
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setLines((c) => [...c, { chartAccountId: '', amount: '', memo: '' }])}
          className="btn px-2 py-1 text-xs"
        >
          Add line
        </button>
        <span className={`tnum text-xs ${remainder === 0 ? 'text-positive' : 'text-warning'}`}>
          {remainder === 0 ? 'Balanced' : `${formatCents(remainder)} left to allocate`}
        </span>
        <button
          onClick={submit}
          disabled={pending || remainder !== 0}
          className="btn btn-primary ml-auto px-3 py-1 text-xs"
        >
          Save split
        </button>
      </div>
    </div>
  )
}

/** Creates a rule seeded from this transaction. */
function RulePanel({ row, accounts, onResult }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState(row.merchantName ?? row.description)
  const [chartAccountId, setChartAccountId] = useState(row.chartAccountId ?? '')
  const [action, setAction] = useState<'auto' | 'suggest'>('suggest')
  const [applyToExisting, setApplyToExisting] = useState(true)

  function submit() {
    startTransition(async () => {
      const result = await createRuleAction({
        name: `Categorize ${value}`,
        field: 'description',
        operator: 'contains',
        value,
        chartAccountId,
        action,
        applyToExisting,
      })
      onResult(result)
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        When a transaction description contains this text, apply the chosen category.
      </p>

      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="field flex-1 py-1.5 text-xs"
          aria-label="Text to match in the description"
        />
        <select
          value={chartAccountId}
          onChange={(event) => setChartAccountId(event.target.value)}
          className="field flex-1 py-1.5 text-xs"
          aria-label="Category to apply"
        >
          <option value="">Choose a category…</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.number} · {account.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={action === 'suggest'}
            onChange={() => setAction('suggest')}
          />
          Suggest for review
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={action === 'auto'} onChange={() => setAction('auto')} />
          Categorize automatically
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={applyToExisting}
            onChange={(event) => setApplyToExisting(event.target.checked)}
          />
          Apply to existing unreviewed transactions
        </label>

        <button
          onClick={submit}
          disabled={pending || !value || !chartAccountId}
          className="btn btn-primary ml-auto px-3 py-1 text-xs"
        >
          Create rule
        </button>
      </div>
    </div>
  )
}

/** Exclude, mark as transfer, and notes. */
function OtherPanel({ row, onResult }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [reason, setReason] = useState('')
  const [note, setNote] = useState(row.notes ?? '')

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      onResult(result)
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason for excluding (optional)"
          className="field flex-1 py-1.5 text-xs"
          aria-label="Reason for excluding"
        />
        <button
          onClick={() => act(() => excludeAction(row.id, reason))}
          disabled={pending}
          className="btn px-3 py-1 text-xs"
        >
          Exclude from books
        </button>
      </div>

      <div>
        <button
          onClick={() => act(() => markTransferAction(row.id))}
          disabled={pending}
          className="btn px-3 py-1 text-xs"
        >
          Mark as a transfer between my accounts
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add a note"
          className="field flex-1 py-1.5 text-xs"
          aria-label="Transaction note"
        />
        <button
          onClick={() => act(() => noteAction(row.id, note))}
          disabled={pending}
          className="btn px-3 py-1 text-xs"
        >
          Save note
        </button>
      </div>
    </div>
  )
}
