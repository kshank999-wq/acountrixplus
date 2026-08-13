'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { connectAndSyncAction } from '@/app/actions/bookkeeping'

/**
 * Pulls the bank feed. With BANK_PROVIDER=mock this connects the sandbox
 * institution on first use, so the demo runs without credentials.
 */
export function SyncButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)

  function sync() {
    startTransition(async () => {
      const result = await connectAndSyncAction()
      setMessage(result.ok ? (result.message ?? 'Synced.') : result.error)
      router.refresh()
      setTimeout(() => setMessage(null), 6000)
    })
  }

  return (
    <div className="relative">
      <button onClick={sync} disabled={pending} className="btn btn-primary text-xs">
        {pending ? 'Syncing…' : 'Sync bank'}
      </button>

      {message && (
        <p
          role="status"
          className="absolute right-0 top-full mt-2 w-64 rounded-lg border border-line bg-surface p-2 text-xs shadow-lg"
        >
          {message}
        </p>
      )}
    </div>
  )
}
