'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  addStepAction,
  cancelCampaignAction,
  sendStepAction,
} from '@/app/actions/marketing'

type Step = {
  id: string
  stepNumber: number
  subject: string
  previewText: string | null
  delayDays: number
  designDocumentId: string | null
}

/**
 * The steps of a campaign, and the button that sends one (spec §10).
 *
 * Sending reports back the full outcome — matched, sent, skipped — rather than
 * a bare "done". A marketer who is told only that a send succeeded will read
 * 40 delivered out of 200 matched as a bug.
 */
export function CampaignSteps({
  campaignId,
  status,
  canManage,
  hasAudience,
  hasFromAddress,
  steps,
  creatives,
}: {
  campaignId: string
  status: string
  canManage: boolean
  hasAudience: boolean
  hasFromAddress: boolean
  steps: Step[]
  creatives: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [adding, setAdding] = useState(false)

  const [subject, setSubject] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [delayDays, setDelayDays] = useState('0')
  const [designDocumentId, setDesignDocumentId] = useState('')

  const isDraft = status === 'draft'
  const isFinished = status === 'sent' || status === 'cancelled'
  const blockers = [
    !hasAudience && 'choose an audience',
    !hasFromAddress && 'set a from address',
    steps.length === 0 && 'add at least one email',
  ].filter(Boolean) as string[]

  function report(result: { ok: boolean; message?: string; error?: string }) {
    setMessage({
      text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Failed.'),
      ok: result.ok,
    })
    if (result.ok) router.refresh()
  }

  return (
    <section className="card overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Emails</h2>
          <p className="text-xs text-muted">
            {steps.length === 0
              ? 'No emails yet.'
              : `${steps.length} step${steps.length === 1 ? '' : 's'} in this campaign.`}
          </p>
        </div>

        {canManage && isDraft && (
          <button onClick={() => setAdding((value) => !value)} className="btn text-xs">
            {adding ? 'Cancel' : 'Add an email'}
          </button>
        )}
      </header>

      {adding && canManage && (
        <div className="space-y-2 border-b border-line bg-raised/40 px-4 py-3">
          <label className="block">
            <span className="text-xs text-muted">Subject</span>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="A quick word before year-end, {{client.contactName}}"
              className="field mt-0.5"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted">Preview text</span>
            <input
              value={previewText}
              onChange={(event) => setPreviewText(event.target.value)}
              placeholder="The line the inbox shows under the subject"
              className="field mt-0.5"
            />
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-muted">Send this many days after the last</span>
              <input
                type="number"
                min={0}
                value={delayDays}
                onChange={(event) => setDelayDays(event.target.value)}
                className="field mt-0.5"
              />
            </label>

            <label className="block">
              <span className="text-xs text-muted">Creative</span>
              <select
                value={designDocumentId}
                onChange={(event) => setDesignDocumentId(event.target.value)}
                className="field mt-0.5"
              >
                <option value="">Choose a design…</option>
                {creatives.map((creative) => (
                  <option key={creative.id} value={creative.id}>
                    {creative.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {creatives.length === 0 && (
            <p className="text-xs text-warning">
              No creative yet —{' '}
              <Link href="/marketing/creative" className="underline">
                design one
              </Link>{' '}
              and this email will have a body.
            </p>
          )}

          <button
            onClick={() =>
              startTransition(async () => {
                const result = await addStepAction(campaignId, {
                  subject,
                  previewText,
                  delayDays: Number(delayDays) || 0,
                  designDocumentId,
                })
                report(result)
                if (result.ok) {
                  setAdding(false)
                  setSubject('')
                  setPreviewText('')
                  setDesignDocumentId('')
                }
              })
            }
            disabled={pending || !subject.trim()}
            className="btn btn-primary text-xs"
          >
            {pending ? 'Adding…' : 'Add email'}
          </button>
        </div>
      )}

      {steps.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          Add an email to give this campaign something to send.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-3 px-4 py-3">
              <span className="tnum chip shrink-0 bg-raised text-muted">{step.stepNumber}</span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{step.subject}</p>
                {step.previewText && (
                  <p className="mt-0.5 text-xs text-muted">{step.previewText}</p>
                )}
                <p className="mt-0.5 text-xs text-faint">
                  {step.delayDays === 0
                    ? 'Sends immediately'
                    : `${step.delayDays} day${step.delayDays === 1 ? '' : 's'} after the previous step`}
                  {!step.designDocumentId && ' · no creative attached'}
                </p>
              </div>

              {canManage && !isFinished && (
                <button
                  onClick={() =>
                    startTransition(async () => {
                      report(await sendStepAction(campaignId, step.stepNumber))
                    })
                  }
                  disabled={pending || blockers.length > 0}
                  title={blockers.length > 0 ? `First ${blockers.join(', ')}.` : undefined}
                  className="btn btn-primary shrink-0 text-xs"
                >
                  {pending ? 'Sending…' : 'Send'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {(message || blockers.length > 0 || (canManage && isDraft)) && (
        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          {blockers.length > 0 && !isFinished && (
            <p className="text-xs text-warning">
              Before sending: {blockers.join(', ')}.
            </p>
          )}

          {message && (
            <p
              role="status"
              className={`text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
            >
              {message.text}
            </p>
          )}

          {canManage && isDraft && (
            <button
              onClick={() =>
                startTransition(async () => {
                  report(await cancelCampaignAction(campaignId))
                })
              }
              disabled={pending}
              className="btn ml-auto text-xs"
            >
              Cancel campaign
            </button>
          )}
        </footer>
      )}
    </section>
  )
}
