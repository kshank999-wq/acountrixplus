'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { revokeDeviceAction } from '@/app/actions/mobile'

type Device = {
  id: string
  label: string
  platform: string
  isInstalled: boolean
  isCurrent: boolean
  lastSeenAt: string
}

/**
 * Where this account is signed in.
 *
 * The whole point is the row that is *not* the current device: a phone left
 * somewhere, a browser on a shared machine. Revoking one deletes its sessions
 * immediately, and every other device — including the one doing the revoking —
 * carries on untouched.
 *
 * Revoking the current device is allowed and confirmed. It is an odd thing to
 * do, but a person with one device and a stolen password has to be able to cut
 * it off, and refusing would leave them with nothing.
 */
export function DeviceList({ devices }: { devices: Device[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  function revoke(id: string) {
    startTransition(async () => {
      const result = await revokeDeviceAction(id)
      setMessage({ text: result.ok ? (result.message ?? 'Done.') : result.error, ok: result.ok })
      setConfirming(null)
      if (result.ok) router.refresh()
    })
  }

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Signed in on</h2>
        <p className="text-xs text-muted">
          Signing a device out here ends its sessions straight away. Nothing else is affected.
        </p>
      </header>

      <ul className="divide-y divide-line">
        {devices.map((device) => (
          <li key={device.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {device.label}
                  {device.isCurrent && (
                    <span className="ml-2 chip bg-action/10 text-action">This device</span>
                  )}
                  {device.isInstalled && (
                    <span className="ml-2 chip bg-raised text-muted">Installed</span>
                  )}
                </p>
                <p className="text-xs text-muted">
                  Last used {formatWhen(device.lastSeenAt)}
                </p>
              </div>

              {confirming === device.id ? (
                <div className="flex shrink-0 gap-1">
                  <button
                    className="btn px-2 py-1 text-xs text-negative"
                    disabled={pending}
                    onClick={() => revoke(device.id)}
                  >
                    {device.isCurrent ? 'Sign me out' : 'Confirm'}
                  </button>
                  <button
                    className="btn px-2 py-1 text-xs"
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="btn shrink-0 px-2 py-1 text-xs"
                  onClick={() => setConfirming(device.id)}
                >
                  Sign out
                </button>
              )}
            </div>

            {confirming === device.id && device.isCurrent && (
              <p className="mt-2 text-xs text-muted">
                This is the device you are using. You will be signed out and sent back to the
                login page.
              </p>
            )}
          </li>
        ))}
      </ul>

      {message && (
        <p
          className={`border-t border-line px-4 py-2 text-xs ${
            message.ok ? 'text-positive' : 'text-negative'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

/** Relative for the recent past, absolute once it stops being memorable. */
function formatWhen(iso: string): string {
  if (!iso) return 'unknown'

  const then = Date.parse(iso)
  const minutes = Math.round((Date.now() - then) / 60_000)

  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} minutes ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} hours ago`
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))} days ago`

  return new Date(then).toISOString().slice(0, 10)
}
