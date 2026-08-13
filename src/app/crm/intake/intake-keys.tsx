'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createIntakeKeyAction, revokeIntakeKeyAction } from '@/app/actions/crm'

type Key = {
  id: string
  name: string
  publicKey: string
  allowedOrigins: string[]
  hourlyLimit: number
  isActive: boolean
  submissionCount: number
  lastUsedAt: string | null
}

type Submission = {
  id: string
  accepted: boolean
  rejectionReason: string | null
  ipPrefix: string | null
  origin: string | null
  receivedAt: string
}

/**
 * Lead intake key management and the embeddable widget (spec §6).
 *
 * The snippet is plain HTML with no dependencies, so it can be pasted into any
 * site builder. The honeypot field is included and visually hidden — it is
 * part of the defence, so shipping the snippet without it would weaken every
 * form built from this page.
 */
export function IntakeKeys({
  baseUrl,
  keys,
  submissions,
  canManage,
}: {
  baseUrl: string
  keys: Key[]
  submissions: Submission[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('Website contact form')
  const [origins, setOrigins] = useState('')
  const [hourlyLimit, setHourlyLimit] = useState(60)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [showSnippetFor, setShowSnippetFor] = useState<string | null>(null)

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Failed.'),
        ok: result.ok,
      })
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="text-sm font-semibold">Website lead intake</h2>
        <p className="mt-0.5 text-xs text-muted">
          A key lets your website post leads into the pipeline. It can only create a lead — it
          cannot read or change anything, and it is scoped to this company.
        </p>

        {canManage && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex-1 text-xs text-muted">
              <span className="mb-1 block">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="field py-1.5 text-sm"
              />
            </label>

            <label className="flex-1 text-xs text-muted">
              <span className="mb-1 block">Allowed origins (comma separated, blank for any)</span>
              <input
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
                placeholder="https://ridgeline.example"
                className="field py-1.5 text-sm"
              />
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Per hour</span>
              <input
                type="number"
                min={1}
                value={hourlyLimit}
                onChange={(event) => setHourlyLimit(Number(event.target.value) || 60)}
                className="field w-24 py-1.5 text-right text-sm"
              />
            </label>

            <button
              onClick={() => act(() => createIntakeKeyAction(name, origins, hourlyLimit))}
              disabled={!name || pending}
              className="btn btn-primary text-xs"
            >
              Create key
            </button>
          </div>
        )}

        {message && (
          <p
            role="status"
            className={`mt-2 text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
          >
            {message.text}
          </p>
        )}
      </section>

      {keys.length > 0 && (
        <section className="card overflow-hidden">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Keys</h2>
          </header>

          <ul className="divide-y divide-line">
            {keys.map((key) => (
              <li key={key.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{key.name}</p>
                    <p className="truncate font-mono text-xs text-faint">{key.publicKey}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted">
                      {key.submissionCount} leads
                      {key.lastUsedAt && ` · last ${key.lastUsedAt}`}
                    </span>
                    <span
                      className={`chip ${
                        key.isActive ? 'bg-positive/15 text-positive' : 'bg-raised text-faint'
                      }`}
                    >
                      {key.isActive ? 'active' : 'revoked'}
                    </span>
                  </div>
                </div>

                <p className="mt-1 text-xs text-faint">
                  {key.allowedOrigins.length > 0
                    ? `Origins: ${key.allowedOrigins.join(', ')}`
                    : 'Any origin permitted'}{' '}
                  · {key.hourlyLimit}/hour
                </p>

                {key.isActive && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      onClick={() =>
                        setShowSnippetFor(showSnippetFor === key.id ? null : key.id)
                      }
                      className="btn px-2 py-1 text-xs"
                    >
                      {showSnippetFor === key.id ? 'Hide snippet' : 'Get form snippet'}
                    </button>
                    {canManage && (
                      <button
                        onClick={() => act(() => revokeIntakeKeyAction(key.id))}
                        disabled={pending}
                        className="btn px-2 py-1 text-xs"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                )}

                {showSnippetFor === key.id && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs text-muted">
                      Paste into your site. The hidden <code>website</code> field is a spam trap —
                      keep it.
                    </p>
                    <pre className="overflow-x-auto rounded-lg bg-raised p-3 text-xs leading-relaxed">
                      <code>{widgetSnippet(baseUrl, key.publicKey)}</code>
                    </pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Recent submissions</h2>
          <p className="text-xs text-muted">
            Rejected attempts are listed too — those are the ones worth looking at. Addresses are
            stored only as a network prefix.
          </p>
        </header>

        {submissions.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Received</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Origin</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((submission) => (
                  <tr key={submission.id} className="border-t border-line">
                    <td className="tnum px-4 py-1.5 text-muted">{submission.receivedAt}</td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`chip ${
                          submission.accepted
                            ? 'bg-positive/15 text-positive'
                            : 'bg-warning/15 text-warning'
                        }`}
                      >
                        {submission.accepted ? 'accepted' : (submission.rejectionReason ?? 'rejected')}
                      </span>
                    </td>
                    <td className="tnum px-4 py-1.5 text-faint">{submission.ipPrefix ?? '—'}</td>
                    <td className="px-4 py-1.5 text-faint">{submission.origin ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/** A dependency-free form that posts to the intake endpoint. */
function widgetSnippet(baseUrl: string, publicKey: string): string {
  return `<form id="accountrix-lead">
  <input name="name" placeholder="Your name" required>
  <input name="email" type="email" placeholder="Email" required>
  <input name="phone" placeholder="Phone">
  <input name="organizationName" placeholder="Company">
  <input name="interest" placeholder="What do you need?">
  <textarea name="message" placeholder="Tell us more"></textarea>
  <label>
    <input name="marketingConsent" type="checkbox">
    Send me occasional updates
  </label>
  <!-- Spam trap: hidden from people, filled in by bots. Keep it. -->
  <input name="website" tabindex="-1" autocomplete="off"
         style="position:absolute;left:-9999px" aria-hidden="true">
  <button type="submit">Send</button>
</form>

<script>
document.getElementById('accountrix-lead').addEventListener('submit', async function (event) {
  event.preventDefault();
  var data = Object.fromEntries(new FormData(event.target).entries());
  data.marketingConsent = 'marketingConsent' in data;

  var response = await fetch('${baseUrl}/api/intake/${publicKey}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  event.target.innerHTML = response.ok
    ? '<p>Thanks — we will be in touch.</p>'
    : '<p>Something went wrong. Please try again.</p>';
});
</script>`
}
