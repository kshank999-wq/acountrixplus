'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { activatePromptAction, savePromptAction } from '@/app/actions/ai'

type Version = { version: number; notes: string | null; isActive: boolean; createdAt: string }

/** One prompt, its versions, and the way back to the built-in. */
export function PromptEditor({
  promptKey,
  builtIn,
  versions,
  activeVersion,
  activeSource,
}: {
  promptKey: string
  builtIn: { version: number; systemPrompt: string; template: string; notes: string }
  versions: Version[]
  activeVersion: number
  activeSource: 'built-in' | 'company'
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [systemPrompt, setSystemPrompt] = useState(builtIn.systemPrompt)
  const [template, setTemplate] = useState(builtIn.template)
  const [notes, setNotes] = useState('')

  function report(result: { ok: boolean; message?: string; error?: string }) {
    setMessage({
      text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Failed.'),
      ok: result.ok,
    })
    if (result.ok) router.refresh()
  }

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-mono text-sm font-medium">{promptKey}</h2>
          <p className="text-xs text-muted">
            Version {activeVersion} active
            {activeSource === 'built-in' ? ' (built-in)' : ' (yours)'}
            {versions.length > 0 && ` · ${versions.length} of your own`}
          </p>
        </div>

        <button onClick={() => setOpen((value) => !value)} className="btn ml-auto text-xs">
          {open ? 'Close' : 'Edit'}
        </button>
      </header>

      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          <label className="block">
            <span className="text-xs text-muted">System prompt — the model&rsquo;s role and rules</span>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={8}
              className="field mt-0.5 font-mono text-xs"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted">
              Template — <span className="font-mono">{'{{placeholders}}'}</span> are filled at
              call time
            </span>
            <textarea
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              rows={8}
              className="field mt-0.5 font-mono text-xs"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted">Why this version — read when rolling back</span>
            <input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Added our own account names"
              className="field mt-0.5"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() =>
                startTransition(async () => {
                  report(
                    await savePromptAction({ key: promptKey, systemPrompt, template, notes }),
                  )
                })
              }
              disabled={pending || !template.trim()}
              className="btn btn-primary text-xs"
            >
              {pending ? 'Saving…' : 'Save as a new version'}
            </button>

            {activeSource === 'company' && (
              <button
                onClick={() =>
                  startTransition(async () => {
                    report(await activatePromptAction(promptKey, null))
                  })
                }
                disabled={pending}
                className="btn text-xs"
              >
                Roll back to built-in
              </button>
            )}
          </div>

          {versions.length > 0 && (
            <ul className="divide-y divide-line border-t border-line pt-2 text-xs">
              {versions.map((version) => (
                <li key={version.version} className="flex items-center gap-2 py-1.5">
                  <span className="tnum">v{version.version}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">
                    {version.notes || 'no note'} · {version.createdAt}
                  </span>
                  {version.isActive ? (
                    <span className="chip bg-brand/15 text-brand">active</span>
                  ) : (
                    <button
                      onClick={() =>
                        startTransition(async () => {
                          report(await activatePromptAction(promptKey, version.version))
                        })
                      }
                      disabled={pending}
                      className="btn px-2 py-0.5 text-xs"
                    >
                      Activate
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {message && (
            <p
              role="status"
              className={`text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
            >
              {message.text}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
