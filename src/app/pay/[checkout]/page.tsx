import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { checkouts, companies, invoices } from '@/db/schema'
import { getPaymentProvider } from '@/modules/payments/registry'
import { formatCents } from '@/lib/money'
import { ConfirmPayment } from './confirm'

export const dynamic = 'force-dynamic'

/**
 * The mock processor's stand-in for a hosted payment page (spec §21).
 *
 * A real processor serves this itself, on its own domain, and **no card
 * details ever reach this application** — which is the whole reason
 * `PaymentProvider.createCheckout` returns a URL rather than a form. This page
 * exists because the mock adapter has nowhere else to point, and it says
 * plainly that nothing is being charged rather than dressing itself up as a
 * card form, which would teach somebody the wrong thing about where their card
 * number goes.
 *
 * It 404s the moment a real adapter is configured. Leaving a page that can
 * complete a payment without a processor would be the most dangerous thing in
 * the codebase.
 */
export default async function MockCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ checkout: string }>
  searchParams: Promise<{ return?: string }>
}) {
  const { checkout } = await params
  const { return: returnUrl } = await searchParams

  if (getPaymentProvider().key !== 'mock') notFound()

  const [row] = await db
    .select({ checkout: checkouts, invoice: invoices, company: companies })
    .from(checkouts)
    .innerJoin(invoices, eq(invoices.id, checkouts.invoiceId))
    .innerJoin(companies, eq(companies.id, checkouts.companyId))
    .where(eq(checkouts.providerCheckoutId, checkout))
    .limit(1)

  if (!row) notFound()

  const settled = row.checkout.status === 'succeeded'
  const failed = row.checkout.status === 'failed'

  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <div className="card px-5 py-6">
        <p className="text-xs uppercase tracking-wide text-muted">Payment to</p>
        <h1 className="text-lg font-semibold">{row.company.name}</h1>

        <p className="mt-4 text-xs uppercase tracking-wide text-muted">Amount</p>
        <p className="tnum text-3xl font-semibold">
          {formatCents(row.checkout.grossCents, row.checkout.currency)}
        </p>
        <p className="mt-1 text-sm text-muted">Invoice {row.invoice.number}</p>

        <div className="mt-6 rounded-lg border border-line bg-raised/60 px-3 py-3 text-sm">
          <p className="font-medium">This is a demonstration.</p>
          <p className="mt-1 text-muted">
            No card is being taken and no money will move. A real payment page is served by the
            card processor on its own site — card details never reach this application. Pressing
            the button below records the payment exactly as a real one would be recorded.
          </p>
        </div>

        {settled ? (
          <p className="mt-5 text-sm text-success">This payment has already been recorded.</p>
        ) : failed ? (
          <p className="mt-5 text-sm text-danger">
            {row.checkout.failureReason ?? 'This payment was declined.'}
          </p>
        ) : (
          <ConfirmPayment
            providerCheckoutId={checkout}
            returnUrl={returnUrl ?? '/'}
            amount={formatCents(row.checkout.grossCents, row.checkout.currency)}
          />
        )}
      </div>
    </main>
  )
}
