import Link from 'next/link'
import { notFound } from 'next/navigation'
import { invoiceByShareToken } from '@/modules/receivables/send'
import { settleCheckout } from '@/modules/payments/service'
import { formatCents } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * Where the processor returns the customer (spec §13, Phase 44).
 *
 * ## Why this page settles rather than just says thank you
 *
 * A customer's browser coming back is the **least** reliable signal that a
 * payment succeeded — they close the tab, the redirect fails, their phone
 * loses signal. So this is not the thing that records the payment; it is one
 * of three that can, alongside a webhook and a sweep, and all three are safe
 * to race because `settleCheckout` claims the row before posting.
 *
 * It settles here anyway because when the redirect *does* arrive it is the
 * fastest of the three, and a customer who paid ten seconds ago and sees an
 * invoice still reading "amount due" concludes their money went nowhere.
 */
export default async function PaidPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ checkout?: string }>
}) {
  const { token } = await params
  const { checkout } = await searchParams

  const found = await invoiceByShareToken(token)
  if (!found) notFound()

  const settled = checkout ? await settleCheckout(checkout) : null

  // Re-read after settling, so the figure shown is the one the payment left
  // behind rather than the one it started from.
  const after = await invoiceByShareToken(token)
  const view = after?.view ?? found.view

  const paid = settled?.ok ?? view.isSettled

  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <div className="card px-5 py-6 text-center">
        {paid ? (
          <>
            <p className="text-lg font-semibold text-success">Thank you — payment received.</p>
            <p className="mt-2 text-sm text-muted">
              {settled?.ok
                ? `${formatCents(settled.grossCents, view.currency)} paid against invoice ${view.number}.`
                : `Invoice ${view.number} is settled.`}
            </p>
          </>
        ) : (
          <>
            <p className="text-lg font-semibold">That payment did not complete.</p>
            <p className="mt-2 text-sm text-muted">
              {settled && !settled.ok ? settled.reason : 'Nothing has been charged.'}
            </p>
          </>
        )}

        {!view.isSettled && (
          <p className="tnum mt-4 text-sm">
            Still outstanding: {formatCents(view.balanceCents, view.currency)}
          </p>
        )}

        <Link href={`/i/${token}`} className="btn mt-6 inline-flex">
          Back to the invoice
        </Link>
      </div>
    </main>
  )
}
