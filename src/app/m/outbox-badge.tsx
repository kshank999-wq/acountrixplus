'use client'

import { useCallback, useEffect, useState } from 'react'
import type { OutboxEntry, QueueSummary } from '@/modules/mobile/outbox'

/**
 * What the queue is doing, shown honestly.
 *
 * The temptation with an offline queue is to hide it: the writes go through
 * eventually, so why bother the person? Because "eventually" is a promise, and
 * an app that made a promise it has not kept yet should say so — especially a
 * bookkeeping app, where the person needs to know whether the thing they just
 * did is actually in the books.
 *
 * Three states, three different messages:
 *
 *  - **Nothing queued** — silent. No badge, no reassurance nobody asked for.
 *  - **Waiting to send** — a quiet line saying how many and that it is handled.
 *  - **Stuck** — loud, with the reason and a way to retry or abandon. This is
 *    the state that must never be silent, because it is the one where work is
 *    at risk.
 */
export function OutboxBadge() {
  const [summary, setSummary] = useState<QueueSummary | null>(null)
  const [failed, setFailed] = useState<OutboxEntry[]>([])
  const [online, setOnline] = useState(true)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const { readQueue, summarize } = await import('./outbox-client')
    const queue = await readQueue()
    setSummary(summarize(queue))
    setFailed(queue.filter((entry) => entry.status === 'failed'))
  }, [])

  useEffect(() => {
    setOnline(navigator.onLine)
    void refresh()

    const onChanged = () => void refresh()
    const onOnline = () => {
      setOnline(true)
      void refresh()
    }
    const onOffline = () => setOnline(false)

    window.addEventListener('accountrix:outbox-changed', onChanged)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      window.removeEventListener('accountrix:outbox-changed', onChanged)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [refresh])

  async function retry() {
    setBusy(true)
    const { retryParked, drainOutbox } = await import('./outbox-client')
    await retryParked()
    await drainOutbox().catch(() => {})
    await refresh()
    setBusy(false)
  }

  async function abandon(id: string) {
    const { discardEntry } = await import('./outbox-client')
    await discardEntry(id)
    await refresh()
  }

  if (!summary) return null

  if (summary.failed > 0) {
    return (
      <div className="card mb-3 border-negative/40 p-3">
        <p className="text-sm font-medium text-negative">
          {summary.failed} {summary.failed === 1 ? 'change' : 'changes'} could not be saved
        </p>
        <ul className="mt-2 space-y-2">
          {failed.map((entry) => (
            <li key={entry.id} className="text-xs">
              <p className="text-muted">
                {describe(entry.operation)} — {entry.lastError ?? 'The server refused it.'}
              </p>
              <button
                className="btn mt-1 px-2 py-1 text-xs"
                onClick={() => void abandon(entry.id)}
              >
                Discard this one
              </button>
            </li>
          ))}
        </ul>
        <button
          className="btn btn-primary mt-3 w-full text-sm"
          onClick={() => void retry()}
          disabled={busy}
        >
          {busy ? 'Trying…' : 'Try again'}
        </button>
      </div>
    )
  }

  if (summary.total > 0) {
    return (
      <p className="mb-3 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
        {summary.total} {summary.total === 1 ? 'change' : 'changes'} saved on this device
        {online ? ' — sending now.' : ' — they will send when you are back online.'}
      </p>
    )
  }

  if (!online) {
    return (
      <p className="mb-3 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
        You are offline. Everything you do here is saved and sent when the connection returns.
      </p>
    )
  }

  return null
}

function describe(operation: string): string {
  switch (operation) {
    case 'transaction.categorize':
      return 'Categorizing a transaction'
    case 'transaction.exclude':
      return 'Excluding a transaction'
    case 'transaction.note':
      return 'Adding a note'
    case 'transaction.split':
      return 'Splitting a transaction'
    case 'receipt.attach':
      return 'Attaching a receipt'
    case 'suggestion.accept':
      return 'Accepting a suggestion'
    default:
      return operation
  }
}
