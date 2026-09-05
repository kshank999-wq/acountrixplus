'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { restatePostingAction, type ActionResult } from '@/app/actions/accounts'
import { CorrectionButton, CorrectionPanel } from '@/components/correction-panel'
import { formatCents } from '@/lib/money'

/**
 * The rows that went into the books at their face value, and the way to put
 * one right (Phase 130).
 *
 * `banking.posted_at_face` finds these and reports them nightly; it took three
 * ADRs to build the correction, and this is where somebody does it. It sits
 * under the accounts table on purpose — the tie-out above is what a person is
 * reading when they want to know whether an account is right, and this is the
 * reason it might not be.
 *
 * Nothing is proposed. The rate is typed by a person, because Phase 129
 * established that the rate table cannot be asked after the fact: the answer it
 * gives today is not the answer that was used, so anything offered here would
 * be a guess wearing a decision's clothes.
 */

export type FaceValuePosting = {
  transactionId: string
  accountName: string
  currency: string
  postedDate: string
  description: string
  amountCents: number
}

export function Restatements({ rows }: { rows: FaceValuePosting[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState<string | null>(null)
  const [rate, setRate] = useState('')
  const [result, setResult] = useState<ActionResult | null>(null)

  // Not `return null` when the list empties (found in the browser, Phase 130).
  // Correcting the last row makes the section unmount, and the confirmation of
  // what somebody just did goes with it — so the one moment they most need to
  // be told is the one moment nothing is said. The notice outlives the list.
  if (rows.length === 0 && !result?.ok) return null

  function submit(transactionId: string, reason: string | null) {
    const parsed = Number(rate)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setResult({ ok: false, error: 'Give the rate as a number greater than zero.' })
      return
    }

    startTransition(async () => {
      const outcome = await restatePostingAction({ transactionId, rate: parsed, reason })
      setResult(outcome)
      if (outcome.ok) {
        setOpen(null)
        setRate('')
        router.refresh()
      }
    })
  }

  return (
    <section className="card mt-6 p-4">
      <h2 className="text-sm font-semibold tracking-tight">
        Postings that went in at their face value
      </h2>
      <p className="mt-1 max-w-3xl text-xs text-muted" hidden={rows.length === 0}>
        These went into the books at the number on the statement rather than what it was worth in{' '}
        your own money — which is what every foreign transaction did before the bank feed learned{' '}
        to convert. A currency can genuinely sit at parity on the day money moved, so this is{' '}
        worth a look rather than proof of anything. Restating posts the difference in a new entry{' '}
        dated today and leaves the original where it is.
      </p>

      {result && (
        <p className={`mt-3 text-xs ${result.ok ? 'text-muted' : 'text-negative'}`}>
          {result.ok ? result.message : result.error}
        </p>
      )}

      {rows.length === 0 && (
        <p className="mt-3 text-xs text-muted">
          Nothing else is waiting. This list is rebuilt from the books each time the page loads,
          so it will come back if another one turns up.
        </p>
      )}

      <ul className="mt-3 divide-y divide-subtle text-sm">
        {rows.map((row) => (
          <li key={row.transactionId} className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="font-medium">{row.description}</span>
                <span className="block text-xs text-muted">
                  {row.postedDate} · {row.accountName} ·{' '}
                  <span className="tnum">{formatCents(row.amountCents, row.currency)}</span> in the
                  books as <span className="tnum">{formatCents(row.amountCents)}</span>
                </span>
              </div>
              <CorrectionButton
                kind="posting.restate"
                open={open === row.transactionId}
                onClick={() => {
                  setResult(null)
                  setRate('')
                  setOpen(open === row.transactionId ? null : row.transactionId)
                }}
              />
            </div>

            {open === row.transactionId && (
              <div className="mt-3">
                <CorrectionPanel
                  kind="posting.restate"
                  pending={pending}
                  onConfirm={(reason) => submit(row.transactionId, reason)}
                >
                  <label className="mt-2 block max-w-[18rem]">
                    <span className="mb-1 block">
                      What was one {row.currency} worth in your own money on {row.postedDate}?
                    </span>
                    <input
                      value={rate}
                      onChange={(event) => setRate(event.target.value)}
                      inputMode="decimal"
                      placeholder="1.1000"
                      className="field py-1.5 text-sm"
                    />
                  </label>
                </CorrectionPanel>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
