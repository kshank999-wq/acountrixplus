'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { formatCents } from '@/lib/money'
import { OutboxBadge } from '../outbox-badge'

type Transaction = {
  id: string
  postedDate: string
  amountCents: number
  description: string
  merchantName: string | null
  suggestedAccountId: string | null
}

type Account = { id: string; number: string; name: string }

/**
 * One transaction at a time, with the whole account list a tap away.
 *
 * ## Why a deck and not a list
 *
 * The desktop inbox is a table, and a table is right there: you scan, you spot
 * the odd one, you fix it. On a phone a table means scrolling past the thing
 * you already decided about to reach the next one, and losing your place every
 * time the keyboard opens.
 *
 * A deck removes the navigation entirely. One transaction fills the screen,
 * a decision advances it, and the only thing to think about is the transaction
 * in front of you. Spec §3 asks for "several transactions at a time" — this is
 * what several at a time looks like when the screen only fits one.
 *
 * ## Nothing here awaits the network
 *
 * Every decision queues locally and the deck advances immediately. That is not
 * an optimization for slow connections; it is the only design that works when
 * there is no connection at all, and it happens to feel instant when there is.
 */
export function ReviewDeck({
  transactions,
  accounts,
}: {
  transactions: Transaction[]
  accounts: Account[]
}) {
  const [index, setIndex] = useState(0)
  const [decided, setDecided] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [queueing, setQueueing] = useState(false)

  const remaining = transactions.filter((row) => !decided[row.id])
  const current = remaining[index] ?? remaining[0] ?? null

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return accounts
    return accounts.filter(
      (account) =>
        account.name.toLowerCase().includes(term) || account.number.includes(term),
    )
  }, [accounts, search])

  /**
   * Recently used accounts, first.
   *
   * A contractor's day is fuel, materials, fuel, materials. Surfacing the last
   * few choices turns the second transaction of a session into one tap instead
   * of a search — and it is derived from this session only, so it never gets
   * stale or needs storing.
   */
  const recent = useMemo(() => {
    const ids = [...new Set(Object.values(decided))].reverse().slice(0, 4)
    return ids
      .map((id) => accounts.find((account) => account.id === id))
      .filter((account): account is Account => Boolean(account))
  }, [decided, accounts])

  async function decide(transaction: Transaction, accountId: string) {
    setQueueing(true)
    try {
      const { queueOperation } = await import('../outbox-client')
      await queueOperation({
        operation: 'transaction.categorize',
        entityId: transaction.id,
        payload: { transactionId: transaction.id, chartAccountId: accountId },
      })

      setDecided((current) => ({ ...current, [transaction.id]: accountId }))
      setSearch('')
      setIndex(0)
      window.dispatchEvent(new CustomEvent('accountrix:outbox-changed'))
    } finally {
      setQueueing(false)
    }
  }

  async function exclude(transaction: Transaction) {
    setQueueing(true)
    try {
      const { queueOperation } = await import('../outbox-client')
      await queueOperation({
        operation: 'transaction.exclude',
        entityId: transaction.id,
        payload: { transactionId: transaction.id, reason: 'Not a business expense' },
      })

      setDecided((current) => ({ ...current, [transaction.id]: 'excluded' }))
      setIndex(0)
      window.dispatchEvent(new CustomEvent('accountrix:outbox-changed'))
    } finally {
      setQueueing(false)
    }
  }

  const done = Object.keys(decided).length

  if (!current) {
    return (
      <div>
        <OutboxBadge />
        <div className="card p-6 text-center">
          <p className="text-sm font-medium">
            {done > 0 ? `${done} reviewed. That is the lot.` : 'Nothing to review.'}
          </p>
          <p className="mt-1 text-xs text-muted">
            {done > 0
              ? 'Your decisions are saved on this device and sent as soon as there is a connection.'
              : 'Every transaction already has a category.'}
          </p>
          <Link href="/m" className="btn mt-4 inline-block text-sm">
            Back to Today
          </Link>
        </div>
      </div>
    )
  }

  const outflow = current.amountCents < 0

  return (
    <div>
      <OutboxBadge />

      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>
          {remaining.length} left{done > 0 ? ` · ${done} done` : ''}
        </span>
        <button
          className="underline"
          onClick={() => setIndex((value) => (value + 1) % Math.max(1, remaining.length))}
          disabled={remaining.length < 2}
        >
          Skip
        </button>
      </div>

      <div className="card p-4">
        <p className="text-xs text-muted">{current.postedDate}</p>
        <p className={`tnum mt-1 text-2xl font-semibold ${outflow ? '' : 'text-positive'}`}>
          {formatCents(Math.abs(current.amountCents))}
          <span className="ml-2 text-xs font-normal text-muted">
            {outflow ? 'out' : 'in'}
          </span>
        </p>
        <p className="mt-1 text-sm font-medium">{current.merchantName ?? current.description}</p>
        {current.merchantName && (
          <p className="text-xs text-muted">{current.description}</p>
        )}
      </div>

      {recent.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-muted">Recently used</p>
          <div className="flex flex-wrap gap-2">
            {recent.map((account) => (
              <button
                key={account.id}
                className="btn px-3 py-2 text-sm"
                disabled={queueing}
                onClick={() => void decide(current, account.id)}
              >
                {account.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <input
        className="field mt-3"
        placeholder="Search categories…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        // No autofocus: opening the keyboard on arrival hides the transaction
        // the person is meant to be looking at.
      />

      <ul className="mt-2 space-y-1">
        {filtered.slice(0, 40).map((account) => (
          <li key={account.id}>
            <button
              // 48px rows: a category list is scrolled with a thumb while the
              // other hand holds a coffee.
              className="flex min-h-[3rem] w-full items-center justify-between gap-3 rounded-lg border border-line px-3 text-left text-sm active:bg-raised"
              disabled={queueing}
              onClick={() => void decide(current, account.id)}
            >
              <span>{account.name}</span>
              <span className="tnum text-xs text-faint">{account.number}</span>
            </button>
          </li>
        ))}
      </ul>

      <button
        className="btn mt-3 w-full text-sm"
        disabled={queueing}
        onClick={() => void exclude(current)}
      >
        Not a business expense
      </button>
    </div>
  )
}
