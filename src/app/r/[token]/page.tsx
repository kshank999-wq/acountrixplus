import { notFound } from 'next/navigation'
import { remittanceByToken } from '@/modules/payables/remittance-send'
import { formatCents } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * The supplier's remittance advice (spec §13, Phase 58).
 *
 * Unauthenticated and read-only. Whoever holds the link is looking at it, so
 * everything here comes from `supplierFacingRemittance` — an allowlist, not the
 * rows — and nothing else on the books is reachable from it.
 *
 * ## Live, and that is what makes the void case work
 *
 * `/s/[token]` renders a statement's **frozen** figures, because a statement is
 * a claim about a moment and the books move underneath it. This renders live,
 * because a posted payment does not change: its applications are written once
 * and the amount is what left the bank.
 *
 * The exception is the reason it is worth stating. Phase 52 made a payment
 * voidable, and a supplier holding an advice for money that came back needs to
 * be told. Reading live is exactly what lets this page say so; a snapshot would
 * have gone on describing a payment that had been unwound.
 */
export default async function PublicRemittancePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const view = await remittanceByToken(token)

  // A dead link is a 404 whether the token is wrong or was never minted.
  // Distinguishing them would tell somebody probing which payments exist.
  if (!view) notFound()

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 print:py-0">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-xl font-semibold">{view.company.name}</h1>
          <div className="mt-1 space-y-0.5 text-sm text-muted">
            {view.company.address.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {view.company.email && <p>{view.company.email}</p>}
            {view.company.phone && <p>{view.company.phone}</p>}
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted">Remittance advice</p>
          <p className="tnum text-lg font-semibold">{view.paymentDate}</p>
          {view.reference && <p className="mt-1 text-sm text-muted">{view.reference}</p>}
        </div>
      </header>

      {/*
        The one thing that can change under a supplier holding this link, and
        the reason the page reads live rather than from a snapshot (Phase 52).
      */}
      {view.isVoided && (
        <p className="mt-5 rounded border border-line bg-raised/60 px-4 py-3 text-sm text-danger">
          <strong>This payment was reversed.</strong> The money described below came back, so the
          invoices it covered are outstanding again.
          {view.voidReason ? ` Reason given: ${view.voidReason}.` : ''} Please get in touch if this
          is unexpected.
        </p>
      )}

      <section className="flex flex-wrap items-end justify-between gap-4 py-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Paid to</p>
          <p className="text-base font-medium">{view.supplierName}</p>
        </div>

        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted">
            {view.isVoided ? 'Was paid' : 'Amount paid'}
          </p>
          <p className={`tnum text-2xl font-semibold ${view.isVoided ? 'line-through' : ''}`}>
            {formatCents(view.amountCents, view.currency)}
          </p>
        </div>
      </section>

      <table className="mt-2 w-full text-sm">
        <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {/* Their reference first: it is what they will search for. */}
            <th className="py-2 font-medium">Your reference</th>
            <th className="py-2 font-medium">Our reference</th>
            <th className="py-2 font-medium">Dated</th>
            <th className="py-2 font-medium">Due</th>
            <th className="py-2 text-right font-medium">Paid</th>
          </tr>
        </thead>
        <tbody>
          {view.bills.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-6 text-center text-muted">
                This payment was made on account rather than against particular invoices.
              </td>
            </tr>
          ) : (
            view.bills.map((bill, i) => (
              <tr key={`${bill.number}-${i}`} className="border-b border-line">
                <td className="py-1.5 font-medium">
                  {bill.vendorReference ?? <span className="text-faint">not recorded</span>}
                </td>
                <td className="py-1.5 text-muted">{bill.number}</td>
                <td className="py-1.5 text-muted">{bill.issueDate}</td>
                <td className="py-1.5 text-muted">{bill.dueDate}</td>
                <td className="tnum py-1.5 text-right">
                  {formatCents(bill.amountCents, view.currency)}
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-line">
            <td colSpan={4} className="py-2 pr-3 text-right font-medium">
              Against invoices
            </td>
            <td className="tnum py-2 text-right font-semibold">
              {formatCents(view.appliedCents, view.currency)}
            </td>
          </tr>
          {/*
            Shown rather than hidden: it is usually a payment on account, and
            the supplier needs to know it is theirs to allocate. Hiding it would
            leave them guessing why the figure does not match.
          */}
          {view.unappliedCents > 0 && (
            <>
              <tr>
                <td colSpan={4} className="py-1.5 pr-3 text-right text-muted">
                  On account
                </td>
                <td className="tnum py-1.5 text-right text-muted">
                  {formatCents(view.unappliedCents, view.currency)}
                </td>
              </tr>
              <tr className="border-t border-line">
                <td colSpan={4} className="py-2 pr-3 text-right font-medium">
                  Total paid
                </td>
                <td className="tnum py-2 text-right font-semibold">
                  {formatCents(view.amountCents, view.currency)}
                </td>
              </tr>
            </>
          )}
        </tfoot>
      </table>

      <footer className="mt-10 border-t border-line pt-4 text-xs text-faint print:hidden">
        {/*
          Two sentences for two situations. Promising "if this is ever reversed
          the page will say so" underneath a banner saying it *was* reversed
          reads as a page arguing with itself.
        */}
        <p>
          {view.isVoided
            ? 'This advice described one payment, which has since been reversed. It stays reachable so the reversal is visible to anybody holding the link.'
            : 'This advice describes one payment and does not change. If the payment is ever reversed, this page will say so.'}{' '}
          Use your browser’s Print to save a copy.
        </p>
      </footer>
    </main>
  )
}
