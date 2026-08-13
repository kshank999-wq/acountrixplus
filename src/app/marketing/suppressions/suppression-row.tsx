'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { unsuppressAction } from '@/app/actions/marketing'

export function SuppressionRow({
  email,
  reason,
  notes,
  createdAt,
  canManage,
}: {
  email: string
  reason: string
  notes: string | null
  createdAt: string | null
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [removed, setRemoved] = useState(false)

  if (removed) return null

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{email}</p>
        <p className="mt-0.5 text-xs text-muted">
          {reason}
          {createdAt && ` · ${createdAt}`}
        </p>
        {notes && <p className="mt-0.5 text-xs text-faint">{notes}</p>}
      </div>

      {canManage && (
        <button
          onClick={() => {
            if (
              !confirm(
                `Remove ${email} from the do-not-email list?\n\nThey will still not receive marketing until they opt in again.`,
              )
            ) {
              return
            }

            startTransition(async () => {
              const result = await unsuppressAction(email)
              if (result.ok) {
                setRemoved(true)
                router.refresh()
              }
            })
          }}
          disabled={pending}
          className="btn shrink-0 text-xs"
        >
          {pending ? 'Removing…' : 'Remove'}
        </button>
      )}
    </li>
  )
}
