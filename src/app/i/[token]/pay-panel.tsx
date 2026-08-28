'use client'

import { useState, useTransition } from 'react'
import { startPaymentAction } from '@/app/actions/pay'
import { formatCents } from '@/lib/money'

/**
 * The Pay button on a customer's invoice.
 *
 * The default is to pay the whole thing in one press, because that is what
 * almost everybody wants and an amount field between a customer and paying is
 * a reason not to. A part payment is one link away for the people who need it.
 *
 * It sends nothing but the token and, optionally, an amount — the server
 * decides everything else from the invoice the token resolves to.
 */
export function PayPanel({
  token,
  balanceCents,
  currency,
}: {
  token: string
  balanceCents: number
  currency: string
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [partial, setPartial] = useState(false)
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2))

  function pay(amountCents?: number) {
    setError(null)
    startTransition(async () => {
      const result = await startPaymentAction({ token, amountCents })
      if (result.ok) {
        // A full navigation rather than a router push: the next page belongs
        // to the processor, not to this application.
        window.location.href = result.url
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <section className="card mt-6 px-4 py-4 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Pay this invoice</p>
          <p className="text-sm text-muted">
            {formatCents(balanceCents, currency)} outstanding. You will be taken to a secure
            payment page.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => pay()}
        >
          {pending ? 'One moment…' : `Pay ${formatCents(balanceCents, currency)}`}
        </button>
      </div>

      {!partial ? (
        <button
          type="button"
          className="mt-3 text-xs text-faint underline"
          onClick={() => setPartial(true)}
        >
          Pay part of it instead
        </button>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            <span className="mb-1 block">Amount to pay</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={(balanceCents / 100).toFixed(2)}
              className="field w-32 py-1.5 text-sm"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn text-sm"
            disabled={pending}
            onClick={() => pay(Math.round(Number(amount) * 100))}
          >
            Pay that
          </button>
          <button
            type="button"
            className="text-xs text-faint underline"
            onClick={() => setPartial(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-danger" role="status">
          {error}
        </p>
      )}
    </section>
  )
}
