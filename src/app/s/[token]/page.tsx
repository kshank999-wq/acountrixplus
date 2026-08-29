import { notFound } from 'next/navigation'
import { statementByToken } from '@/modules/receivables/statement-send'
import { formatCents } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * The customer's statement of account (spec §13, Phase 55).
 *
 * Unauthenticated and read-only. Whoever holds the link is looking at it, so
 * everything here comes from `customerFacingStatement` — an allowlist, not the
 * row — and nothing else on the books is reachable from it.
 *
 * ## Frozen, unlike the invoice page next door
 *
 * `/i/[token]` renders the **live** invoice, and it is right to: a customer
 * chasing their own payables wants to know what is outstanding now, so a part
 * payment does not force a reissue.
 *
 * This page is the opposite on purpose. A statement is a claim about a
 * **moment** — "this is where we stood at 30 June" — and it exists so two
 * parties can reconcile against a fixed thing. A page that silently restated
 * itself every time it was opened would mean the customer and the business
 * could never be looking at the same document, which is the only job a
 * statement has. So the figures are the ones frozen when it was saved, and the
 * page says so twice: at the top, and again at the bottom.
 */
export default async function PublicStatementPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const view = await statementByToken(token)

  // A dead link is a 404 whether the token is wrong or was never minted.
  // Distinguishing them would tell somebody probing which statements exist.
  if (!view) notFound()

  const isOpenItem = view.kind === 'open_item'

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
          <p className="text-xs uppercase tracking-wide text-muted">Statement</p>
          <p className="tnum text-lg font-semibold">As at {view.asOfDate}</p>
          <p className="mt-1 text-sm text-muted">
            {isOpenItem ? 'Open items' : 'Balance forward'}
            {view.periodStart && (
              <>
                <br />
                From {view.periodStart}
              </>
            )}
          </p>
        </div>
      </header>

      <section className="flex flex-wrap items-end justify-between gap-4 py-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Account of</p>
          <p className="text-base font-medium">{view.customerName}</p>
        </div>

        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted">
            {view.dueCents === 0 ? 'Nothing due' : 'Amount due'}
          </p>
          <p className="tnum text-2xl font-semibold">
            {formatCents(view.dueCents, view.currency)}
          </p>
        </div>
      </section>

      {/*
        Phase 54's sentence, finally addressed to somebody who can read it. It
        was computed and frozen onto the row a phase before anything could send
        the document it was written for.
      */}
      {view.positionNote && (
        <p className="rounded border border-line bg-raised/60 px-4 py-3 text-sm">
          {view.positionNote}
        </p>
      )}

      {/*
        Phase 54's sentence covers the balance in our own currency, because a
        credit we are holding is only knowable in ours. Silence here would
        leave somebody reading "nothing is due" over a euro invoice listed
        below it (Phase 61).
      */}
      {view.foreignNote && (
        <p className="mt-3 rounded border border-line bg-raised/60 px-4 py-3 text-sm text-danger">
          {view.foreignNote}
        </p>
      )}

      <table className="mt-6 w-full text-sm">
        <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="py-2 font-medium">Date</th>
            <th className="py-2 font-medium">Reference</th>
            <th className="py-2 font-medium">Detail</th>
            {isOpenItem && <th className="py-2 font-medium">Due</th>}
            <th className="py-2 text-right font-medium">Amount</th>
            {!isOpenItem && <th className="py-2 text-right font-medium">Balance</th>}
          </tr>
        </thead>
        <tbody>
          {view.lines.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-6 text-center text-muted">
                Nothing was outstanding at {view.asOfDate}.
              </td>
            </tr>
          ) : (
            view.lines.map((line, i) => (
              <tr key={`${line.reference}-${i}`} className="border-b border-line">
                <td className="py-1.5 text-muted">{line.date}</td>
                <td className="py-1.5">{line.reference}</td>
                <td className="py-1.5">{line.description}</td>
                {isOpenItem && <td className="py-1.5 text-muted">{line.dueDate ?? '—'}</td>}
                <td className="tnum py-1.5 text-right">
                  {/* What they were invoiced, in their money (Phase 61). */}
                  {formatCents(line.amountCents, line.currency ?? view.currency)}
                </td>
                {!isOpenItem && (
                  <td className="tnum py-1.5 text-right text-muted">
                    {formatCents(line.runningBalanceCents, view.currency)}
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          {!isOpenItem && (
            <tr>
              <td colSpan={4} className="py-1.5 pr-3 text-right text-muted">
                Brought forward
              </td>
              <td className="tnum py-1.5 text-right text-muted">
                {formatCents(view.openingBalanceCents, view.currency)}
              </td>
            </tr>
          )}
          {/*
            One row per currency, because a total across currencies is not a
            quantity of money and this document is asking somebody to send one
            (Phase 61). For almost every statement there is exactly one row and
            this reads as it always did.
          */}
          {(view.currencyBalances.length > 0
            ? view.currencyBalances
            : [{ currency: view.currency, balanceCents: view.closingBalanceCents, functionalBalanceCents: view.closingBalanceCents }]
          ).map((balance) => (
            <tr key={balance.currency} className="border-t border-line">
              <td colSpan={4} className="py-2 pr-3 text-right font-medium">
                Billed and open
                {view.currencyBalances.length > 1 && (
                  <span className="text-muted"> in {balance.currency}</span>
                )}
              </td>
              <td className="tnum py-2 text-right font-semibold">
                {formatCents(balance.balanceCents, balance.currency)}
              </td>
            </tr>
          ))}
          {/*
            The gross is kept above the net, because a customer reconciling
            against their own purchase ledger needs to see what was billed
            (Phase 54). Showing only the net would leave them unable to tie the
            document to their own records.
          */}
          {/*
            Per currency since Phase 62, because a receipt now keeps the
            currency it was in. This used to print "−$500.00" against a €500
            overpayment: the right number with the wrong money on it.
          */}
          {(view.positions.length > 0
            ? view.positions.filter((row) => row.heldCents > 0)
            : view.heldCreditCents > 0
              ? [{ currency: view.currency, heldCents: view.heldCreditCents, dueCents: view.dueCents }]
              : []
          ).map((position) => (
            <tr key={`held-${position.currency}`}>
              <td colSpan={4} className="py-1.5 pr-3 text-right text-muted">
                Held for you
                {view.positions.length > 1 && (
                  <span className="text-faint"> in {position.currency}</span>
                )}
              </td>
              <td className="tnum py-1.5 text-right text-success">
                −{formatCents(position.heldCents, position.currency)}
              </td>
            </tr>
          ))}
          {/* What to actually send, per currency, once credit is set off. */}
          {view.heldCreditCents > 0 &&
            (view.positions.length > 0
              ? view.positions
              : [{ currency: view.currency, dueCents: view.dueCents }]
            ).map((position) => (
              <tr key={`due-${position.currency}`} className="border-t border-line">
                <td colSpan={4} className="py-2 pr-3 text-right font-medium">
                  Amount due
                  {view.positions.length > 1 && (
                    <span className="text-muted"> in {position.currency}</span>
                  )}
                </td>
                <td className="tnum py-2 text-right font-semibold">
                  {formatCents(position.dueCents, position.currency)}
                </td>
              </tr>
            ))}
        </tfoot>
      </table>

      <footer className="mt-10 border-t border-line pt-4 text-xs text-faint print:hidden">
        <p>
          These figures are as at {view.asOfDate} and do not change — this is the document to
          reconcile against. Anything paid since will be on the next statement. Use your browser’s
          Print to save a copy.
        </p>
      </footer>
    </main>
  )
}
