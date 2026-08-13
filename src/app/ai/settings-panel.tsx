'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateAiSettingsAction } from '@/app/actions/ai'
import { FEATURE_LABELS } from './nav'

type Settings = {
  enabled: boolean
  provider: string
  model: string
  monthlyCeilingDollars: number
  hourlyRequestLimit: number
  disabledFeatures: string[]
}

/**
 * Switching the module on and off, and the controls spec §12 requires:
 * provider selection, a cost ceiling, a rate limit, and per-capability
 * enablement.
 *
 * The off switch is at the top and unmissable, because the most important
 * thing about this module is that a company can decline it entirely and lose
 * nothing (spec §23).
 */
export function SettingsPanel({
  settings,
  providers,
  effectiveModel,
}: {
  settings: Settings
  providers: Array<{ key: string; configured: boolean }>
  effectiveModel: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [enabled, setEnabled] = useState(settings.enabled)
  const [provider, setProvider] = useState(settings.provider)
  const [model, setModel] = useState(settings.model)
  const [ceiling, setCeiling] = useState(String(settings.monthlyCeilingDollars))
  const [hourly, setHourly] = useState(String(settings.hourlyRequestLimit))
  const [disabled, setDisabled] = useState<string[]>(settings.disabledFeatures)

  function toggleFeature(feature: string) {
    setDisabled((current) =>
      current.includes(feature)
        ? current.filter((entry) => entry !== feature)
        : [...current, feature],
    )
  }

  function save() {
    startTransition(async () => {
      const result = await updateAiSettingsAction({
        enabled,
        provider,
        model,
        monthlyCeilingDollars: Number(ceiling) || 0,
        hourlyRequestLimit: Number(hourly) || 1,
        disabledFeatures: disabled,
      })

      setMessage({ text: result.ok ? (result.message ?? 'Saved.') : result.error, ok: result.ok })
      if (result.ok) router.refresh()
    })
  }

  return (
    <section className="card h-fit p-4">
      <h2 className="text-sm font-semibold">Module settings</h2>

      <label className="mt-3 flex items-start gap-2 rounded-lg border border-line p-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="text-sm font-medium">Enable the AI module</span>
          <span className="mt-0.5 block text-xs text-muted">
            Off by default. Nothing else in the product depends on it.
          </span>
        </span>
      </label>

      <label className="mt-3 block">
        <span className="text-xs text-muted">Provider</span>
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          className="field mt-0.5"
        >
          {providers.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.key}
              {entry.configured ? '' : ' — no credentials'}
            </option>
          ))}
        </select>
        <span className="mt-0.5 block text-xs text-faint">
          Currently answering as <span className="font-mono">{effectiveModel}</span>.
        </span>
      </label>

      <label className="mt-3 block">
        <span className="text-xs text-muted">Model (optional)</span>
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="the provider's default"
          className="field mt-0.5 font-mono text-xs"
        />
      </label>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-muted">Monthly ceiling ($)</span>
          <input
            type="number"
            min={0}
            step="0.5"
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value)}
            className="field mt-0.5"
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Requests per hour</span>
          <input
            type="number"
            min={1}
            value={hourly}
            onChange={(event) => setHourly(event.target.value)}
            className="field mt-0.5"
          />
        </label>
      </div>
      <p className="mt-1 text-xs text-faint">
        A request that would cross the ceiling is refused before it reaches a provider, so the
        ceiling is a limit rather than a warning.
      </p>

      <fieldset className="mt-4 border-t border-line pt-3">
        <legend className="sr-only">Capabilities</legend>
        <p className="text-xs font-medium">Capabilities</p>
        <ul className="mt-2 space-y-1.5">
          {Object.entries(FEATURE_LABELS).map(([feature, label]) => (
            <li key={feature}>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!disabled.includes(feature)}
                  onChange={() => toggleFeature(feature)}
                />
                <span className={disabled.includes(feature) ? 'text-faint' : ''}>{label}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <button
        onClick={save}
        disabled={pending}
        className="btn btn-primary mt-4 w-full text-xs"
      >
        {pending ? 'Saving…' : 'Save settings'}
      </button>

      {message && (
        <p
          role="status"
          className={`mt-2 text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}
