'use client'

import { useState, useTransition } from 'react'
import { confirmMockPaymentAction } from '@/app/actions/pay'

/**
 * The button that stands in for a customer typing a card number.
 *
 * The failure it shows is the processor's own words, unchanged — a decline is
 * a thing the customer needs to understand and act on ("try another card"),
 * and rewording it into something friendlier would leave them not knowing what
 * went wrong.
 */
export function ConfirmPayment({
  providerCheckoutId,
  returnUrl,
  amount,
}: {
  providerCheckoutId: string
  returnUrl: string
  amount: string
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function confirm() {
    setError(null)
    startTransition(async () => {
      const result = await confirmMockPaymentAction({ providerCheckoutId, returnUrl })
      if (result.ok) {
        window.location.href = result.returnUrl
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <div className="mt-5">
      <button type="button" className="btn btn-primary w-full" disabled={pending} onClick={confirm}>
        {pending ? 'Taking payment…' : `Pay ${amount}`}
      </button>

      {error && (
        <p className="mt-3 text-sm text-danger" role="status">
          {error}
        </p>
      )}
    </div>
  )
}
