import { notFound } from 'next/navigation'
import { invoiceByShareToken, recordInvoiceView } from '@/modules/receivables/send'
import { formatCents } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * The customer's invoice (spec §13).
 *
 * Unauthenticated and read-only. Whoever holds the link is looking at it, so
 * everything on this page comes from `customerFacingInvoice` — an allowlist,
 * not the row — and nothing else on the books is reachable from here.
 *
 * It renders the **live** record, so the balance moves as they pay. That is
 * deliberate and is the same argument `modules/pdf/invoice.ts` made against
 * snapshotting: there is one ledger, and a stored copy would be a second
 * answer to how much is owed.
 */
export default async function PublicInvoicePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const found = await invoiceByShareToken(token)

  // A dead link is a 404 whether the token is wrong, expired or revoked.
  // Distinguishing them would tell somebody probing which invoices exist.
  if (!found) notFound()

  await recordInvoiceView(token)

  const { view } = found
  const quantity = (milli: number) => (milli / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 print:py-0">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-xl font-semibold">{view.company.name}</h1>
          <div className="mt-1 space-y-0.5 text-sm text-muted">
            {view.company.addressLine && <p>{view.company.addressLine}</p>}
            {view.company.email && <p>{view.company.email}</p>}
            {view.company.phone && <p>{view.company.phone}</p>}
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted">Invoice</p>
          <p className="tnum text-lg font-semibold">{view.number}</p>
          <p className="mt-1 text-sm text-muted">
            Issued {view.issueDate}
            <br />
            Due {view.dueDate}
          </p>
        </div>
      </header>

      <section className="flex flex-wrap items-end justify-between gap-4 py-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Billed to</p>
          <p className="text-base font-medium">{view.customerName}</p>
        </div>

        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted">
            {view.isSettled ? 'Paid in full' : 'Amount due'}
          </p>
          <p
            className={`tnum text-3xl font-semibold ${
              view.isSettled ? 'text-success' : view.isOverdue ? 'text-danger' : ''
            }`}
          >
            {formatCents(view.balanceCents, view.currency)}
          </p>
          {view.isOverdue && !view.isSettled && (
            <p className="text-sm text-danger">Overdue since {view.dueDate}.</p>
          )}
          {view.paidCents > 0 && !view.isSettled && (
            <p className="text-sm text-muted">
              {formatCents(view.paidCents, view.currency)} received, thank you.
            </p>
          )}
        </div>
      </section>

      <table className="w-full text-sm">
        <thead className="border-y border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="py-2 font-medium">Description</th>
            <th className="py-2 text-right font-medium">Qty</th>
            <th className="py-2 text-right font-medium">Each</th>
            <th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {view.lines.map((line, index) => (
            <tr key={index} className="border-b border-line">
              <td className="py-2 pr-3">{line.description}</td>
              <td className="tnum py-2 text-right text-muted">{quantity(line.quantityMilli)}</td>
              <td className="tnum py-2 text-right text-muted">
                {formatCents(line.unitPriceCents, view.currency)}
              </td>
              <td className="tnum py-2 text-right">
                {formatCents(line.amountCents, view.currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="py-1.5 pr-3 text-right text-muted">
              Subtotal
            </td>
            <td className="tnum py-1.5 text-right">
              {formatCents(view.subtotalCents, view.currency)}
            </td>
          </tr>
          {view.taxCents > 0 && (
            <tr>
              <td colSpan={3} className="py-1.5 pr-3 text-right text-muted">
                Tax
              </td>
              <td className="tnum py-1.5 text-right">
                {formatCents(view.taxCents, view.currency)}
              </td>
            </tr>
          )}
          <tr className="border-t border-line">
            <td colSpan={3} className="py-2 pr-3 text-right font-medium">
              Total
            </td>
            <td className="tnum py-2 text-right font-semibold">
              {formatCents(view.totalCents, view.currency)}
            </td>
          </tr>
          {view.paidCents > 0 && (
            <>
              <tr>
                <td colSpan={3} className="py-1.5 pr-3 text-right text-muted">
                  Received
                </td>
                <td className="tnum py-1.5 text-right text-muted">
                  −{formatCents(view.paidCents, view.currency)}
                </td>
              </tr>
              <tr className="border-t border-line">
                <td colSpan={3} className="py-2 pr-3 text-right font-medium">
                  Amount due
                </td>
                <td className="tnum py-2 text-right font-semibold">
                  {formatCents(view.balanceCents, view.currency)}
                </td>
              </tr>
            </>
          )}
        </tfoot>
      </table>

      {view.memo && <p className="mt-6 text-sm text-muted">{view.memo}</p>}

      <footer className="mt-10 border-t border-line pt-4 text-xs text-faint print:hidden">
        <p>
          This page always shows what is currently outstanding, so it stays right after a part
          payment. Use your browser’s Print to save a copy.
        </p>
      </footer>
    </main>
  )
}
