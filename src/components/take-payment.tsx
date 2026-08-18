'use client'

import { useState } from 'react'
import { formatCents } from '@/lib/money'

type TenderKind = 'cash' | 'card' | 'gift_card' | 'bank_transfer' | 'cheque' | 'other'

type Result = { ok: true; message?: string } | { ok: false; error: string }

/**
 * Taking money for one bill, at a desk (Phase 32).
 *
 * Shared between the appointments board and the shop, because it is the same
 * gesture in both — and because the change calculation has to be identical in
 * both or one of them is wrong.
 *
 * The amount defaults to what is owed and cash is preselected, so the common
 * case is one press. Change is shown *before* anything is submitted: somebody
 * counting notes out of a drawer needs the number in front of them, not in a
 * confirmation afterwards.
 */
export function TakePayment({
  invoiceId,
  outstandingCents,
  today,
  act,
  pending,
  takePaymentAction,
}: {
  invoiceId: string
  outstandingCents: number
  today: string
  act: (fn: () => Promise<Result>) => void
  pending: boolean
  takePaymentAction: (input: unknown) => Promise<Result>
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<TenderKind>('cash')
  const [amount, setAmount] = useState((outstandingCents / 100).toFixed(2))
  const [reference, setReference] = useState('')

  const tenderedCents = Math.round(Number(amount) * 100) || 0

  // Mirrors `tenderFor`: change is cash-only, and a card over the bill is an
  // error rather than a payment. Shown here so the answer is visible before
  // anybody presses anything — the server still decides.
  const overCents = Math.max(0, tenderedCents - outstandingCents)
  const changeCents = kind === 'cash' ? overCents : 0
  const overchargeCents = kind === 'cash' ? 0 : overCents
  const shortCents = Math.max(0, outstandingCents - tenderedCents)

  if (!open) {
    return (
      <button className="btn btn-primary text-xs" onClick={() => setOpen(true)}>
        Take {formatCents(outstandingCents)}
      </button>
    )
  }

  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-line bg-raised/40 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        act(() =>
          takePaymentAction({
            invoiceId,
            receivedOn: today,
            tenders: [
              {
                kind,
                amountCents: tenderedCents,
                reference: reference.trim() || undefined,
              },
            ],
          }),
        )
        setOpen(false)
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs">
          <span className="block text-faint">How</span>
          <select
            className="field"
            onChange={(event) => setKind(event.target.value as TenderKind)}
            value={kind}
          >
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="cheque">Cheque</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="block text-faint">Tendered</span>
          <input
            className="field"
            min="0.01"
            onChange={(event) => setAmount(event.target.value)}
            step="0.01"
            type="number"
            value={amount}
          />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Reference</span>
          <input
            className="field"
            onChange={(event) => setReference(event.target.value)}
            placeholder={kind === 'card' ? 'Last four' : ''}
            value={reference}
          />
        </label>
      </div>

      <p className="text-xs">
        {overchargeCents > 0 ? (
          <span className="text-danger">
            That is {formatCents(overchargeCents)} more than is owed, and change cannot be given on
            a {kind === 'bank_transfer' ? 'bank transfer' : kind}. Take{' '}
            {formatCents(outstandingCents)} instead.
          </span>
        ) : changeCents > 0 ? (
          <span className="text-success">
            {formatCents(outstandingCents)} taken · <strong>{formatCents(changeCents)} change</strong>
          </span>
        ) : shortCents > 0 ? (
          <span className="text-warning">
            {formatCents(tenderedCents)} taken · {formatCents(shortCents)} still owing
          </span>
        ) : (
          <span className="text-success">Settles it exactly.</span>
        )}
      </p>

      <div className="flex gap-2">
        <button
          className="btn btn-primary text-xs"
          disabled={pending || tenderedCents === 0 || overchargeCents > 0}
          type="submit"
        >
          Take it
        </button>
        <button className="btn text-xs" onClick={() => setOpen(false)} type="button">
          Never mind
        </button>
      </div>

      <p className="text-xs text-faint">
        Takings go to Undeposited Funds — a note in the drawer and a card batch not yet settled are
        both money at the counter, and neither is money in the bank until somebody banks it.
      </p>
    </form>
  )
}
