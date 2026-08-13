'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createCampaignAction } from '@/app/actions/marketing'

/**
 * Creating a campaign (spec §10).
 *
 * Only the shell is created here — audience, from address, schedule. The
 * emails themselves are added as steps on the campaign page, because a nurture
 * sequence is several of them and a form that tried to capture all of it at
 * once would be a wall.
 */
export function CampaignComposer({
  segments,
  defaultFromName,
}: {
  segments: Array<{ id: string; name: string }>
  defaultFromName: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [kind, setKind] = useState<'broadcast' | 'nurture'>('broadcast')
  const [segmentId, setSegmentId] = useState('')
  const [fromName, setFromName] = useState(defaultFromName)
  const [fromEmail, setFromEmail] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')

  function create() {
    setError(null)

    startTransition(async () => {
      const result = await createCampaignAction({
        name,
        kind,
        segmentId,
        fromName,
        fromEmail,
        replyTo,
        scheduledFor,
      })

      if (result.ok && result.campaignId) {
        router.push(`/marketing/campaigns/${result.campaignId}`)
      } else if (!result.ok) {
        setError(result.error)
      }
    })
  }

  return (
    <section className="card h-fit p-4">
      <h2 className="text-sm font-semibold">New campaign</h2>

      {segments.length === 0 && (
        <p className="mt-2 text-xs text-warning">
          Build a segment first — a campaign needs an audience before it can send.
        </p>
      )}

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs text-muted">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Spring year-end reminder"
            className="field mt-0.5"
          />
        </label>

        <label className="block">
          <span className="text-xs text-muted">Kind</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as 'broadcast' | 'nurture')}
            className="field mt-0.5"
          >
            <option value="broadcast">Broadcast — one email</option>
            <option value="nurture">Nurture — a sequence</option>
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-muted">Audience</span>
          <select
            value={segmentId}
            onChange={(event) => setSegmentId(event.target.value)}
            className="field mt-0.5"
          >
            <option value="">Choose a segment…</option>
            {segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-muted">From name</span>
            <input
              value={fromName}
              onChange={(event) => setFromName(event.target.value)}
              className="field mt-0.5"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">From address</span>
            <input
              type="email"
              value={fromEmail}
              onChange={(event) => setFromEmail(event.target.value)}
              placeholder="hello@yourfirm.com"
              className="field mt-0.5"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs text-muted">Reply-to (optional)</span>
          <input
            type="email"
            value={replyTo}
            onChange={(event) => setReplyTo(event.target.value)}
            className="field mt-0.5"
          />
        </label>

        <label className="block">
          <span className="text-xs text-muted">Scheduled for (optional)</span>
          <input
            type="date"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
            className="field mt-0.5"
          />
          <span className="mt-0.5 block text-xs text-faint">
            Shown on the calendar. Sending is still something you press.
          </span>
        </label>

        {error && (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        )}

        <button
          onClick={create}
          disabled={pending || !name.trim()}
          className="btn btn-primary w-full text-xs"
        >
          {pending ? 'Creating…' : 'Create campaign'}
        </button>
      </div>
    </section>
  )
}
