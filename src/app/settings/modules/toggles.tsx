'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toggleModuleAction } from '@/app/actions/jobs'

type ModuleRow = {
  key: string
  label: string
  description: string
  enabled: boolean
  packDefault: boolean
  overridden: boolean
  implemented: boolean
}

/**
 * Module switches.
 *
 * Modules Phase 7 has not built yet are shown but not switchable, and say so.
 * The alternative — hiding them — would make the roadmap invisible; the other
 * alternative, letting somebody switch on a workspace that does not exist, is
 * worse.
 */
export function ModuleToggles({ modules }: { modules: ModuleRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  /**
   * Local echo of the switch that is mid-flight.
   *
   * Without it the checkbox is driven straight from the server prop, so
   * clicking it snaps it back until the round trip lands — which reads as "that
   * did not work" for the second or so it takes.
   */
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({})

  function toggle(key: string, enabled: boolean) {
    setOptimistic((current) => ({ ...current, [key]: enabled }))

    startTransition(async () => {
      const result = await toggleModuleAction(key, enabled)
      setMessage({ text: result.ok ? (result.message ?? 'Saved.') : result.error, ok: result.ok })

      if (result.ok) {
        router.refresh()
      } else {
        // Put the switch back where it was: the server said no.
        setOptimistic((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
      }
    })
  }

  const isOn = (entry: ModuleRow) => optimistic[entry.key] ?? entry.enabled

  const available = modules.filter((entry) => entry.implemented)
  const planned = modules.filter((entry) => !entry.implemented)

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Available now</h2>
        </header>
        <ul className="divide-y divide-line">
          {available.map((entry) => (
            <li key={entry.key} className="flex items-start gap-3 p-4">
              <input
                id={`module-${entry.key}`}
                type="checkbox"
                className="mt-1"
                checked={isOn(entry)}
                disabled={pending}
                onChange={(event) => toggle(entry.key, event.target.checked)}
              />
              <label htmlFor={`module-${entry.key}`} className="min-w-0 flex-1 cursor-pointer">
                <span className="text-sm font-medium">{entry.label}</span>
                {entry.packDefault && (
                  <span className="ml-2 chip bg-raised text-muted">on by default for your industry</span>
                )}
                {entry.overridden && (
                  <span className="ml-2 chip bg-action/10 text-action">changed from the default</span>
                )}
                <span className="mt-0.5 block text-xs text-muted">{entry.description}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Not built yet</h2>
          <p className="text-xs text-muted">
            Declared in the industry packs and switched on by some of them, but the workflows are
            not implemented. Listed here rather than hidden so the roadmap is visible.
          </p>
        </header>
        <ul className="divide-y divide-line">
          {planned.map((entry) => (
            <li key={entry.key} className="flex items-start gap-3 p-4 opacity-60">
              <input type="checkbox" className="mt-1" checked={entry.enabled} disabled readOnly />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{entry.label}</span>
                {entry.packDefault && (
                  <span className="ml-2 chip bg-raised text-muted">your industry pack asks for it</span>
                )}
                <span className="mt-0.5 block text-xs text-muted">{entry.description}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {message && (
        <p className={`text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}
