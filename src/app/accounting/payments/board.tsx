'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  applyCustomerCreditAction,
  refundCustomerCreditAction,
  voidPaymentAction,
  type ActionResult,
} from '@/app/actions/payables'
import { sendRemittanceAction, shareRemittanceAction } from '@/app/actions/remittance'
import type { VoidVerdict } from '@/modules/receivables/payment-void'
import { formatCents, parseAmountToCents } from '@/lib/money'
import { CorrectionButton, CorrectionPanel } from '@/components/correction-panel'

type Row = {
  id: string
  kind: 'receipt' | 'disbursement'
  paymentDate: string
  amountCents: number
  status: 'posted' | 'void'
  reference: string | null
  partyName: string | null
  voidReason: string | null
  restorations: { number: string; amountCents: number; status: 'open' | 'partial' }[]
  verdict: VoidVerdict
  /** When the supplier was told what this payment covered (Phase 58). */
  remittanceSentAt: string | null
  remittanceSendCount: number
}

type Credit = {
  paymentId: string
  customerId: string
  customerName: string
  paymentDate: string
  reference: string | null
  availableCents: number
  openInvoices: { id: string; number: string; balanceCents: number }[]
}

type Account = { id: string; name: string; mask: string | null }

/**
 * Money in and out (Phase 52, Phase 53).
 *
 * Payments were recorded from two screens and never listed again, and there was
 * no way to take one back at all — no status column on `payments`, no service
 * function, nothing. A receipt keyed at ten times its amount was permanent.
 */
export function PaymentsBoard({
  rows,
  credits,
  accounts,
  today,
  canVoid,
}: {
  rows: Row[]
  credits: Credit[]
  accounts: Account[]
  today: string
  canVoid: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  // Which row's confirmation is open. The reason inside it belongs to the
  // panel, which is unmounted with the row — so closing one and opening another
  // cannot carry a half-typed reason across to a different payment.
  const [openId, setOpenId] = useState<string | null>(null)

  // Held credit (Phase 53).
  const [creditId, setCreditId] = useState('')
  const [creditInvoiceId, setCreditInvoiceId] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [refundAccountId, setRefundAccountId] = useState(accounts[0]?.id ?? '')
  const [refundReference, setRefundReference] = useState('')

  const totals = useMemo(() => {
    const live = rows.filter((row) => row.status === 'posted')
    return {
      inCents: live.filter((r) => r.kind === 'receipt').reduce((s, r) => s + r.amountCents, 0),
      outCents: live
        .filter((r) => r.kind === 'disbursement')
        .reduce((s, r) => s + r.amountCents, 0),
      voided: rows.filter((row) => row.status === 'void').length,
    }
  }, [rows])

  const chosenCredit = credits.find((row) => row.paymentId === creditId) ?? null

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) {
        setOpenId(null)
        setCreditId('')
        setCreditInvoiceId('')
        setRefundAmount('')
        setRefundReference('')
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Money in and out</h2>
        <p className="text-sm text-muted">
          Every payment recorded, newest first.{' '}
          <span className="text-faint">
            Taking one back puts what it settled straight back onto the document, and unwinds the
            ledger with it. Voided payments stay listed.
          </span>
        </p>
      </header>

      {notice && (
        <p
          className={`card px-4 py-3 text-sm ${
            notice.ok ? 'text-success' : 'border-danger/40 text-danger'
          }`}
          role="status"
        >
          {notice.text}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted">Received</p>
          <p className="tnum text-xl font-semibold text-success">{formatCents(totals.inCents)}</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted">Paid out</p>
          <p className="tnum text-xl font-semibold">{formatCents(totals.outCents)}</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted">Taken back</p>
          <p className="tnum text-xl font-semibold text-faint">{totals.voided}</p>
        </div>
      </div>

      {/* Money customers sent beyond what they owed (Phase 53). The screen
          used to refuse to record it at all, telling the business to write
          down a figure the bank statement disagrees with. */}
      {credits.length > 0 && (
        <section className="card px-4 py-4">
          <h3 className="text-sm font-semibold">Credit we are holding for customers</h3>
          <p className="mt-1 text-sm text-muted">
            Money sent beyond what was owed.{' '}
            <span className="text-faint">
              It goes against their next invoice, or back to them — and until one of those
              happens the business owes it.
            </span>
          </p>

          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 font-medium">Customer</th>
                <th className="py-1 font-medium">Received</th>
                <th className="py-1 text-right font-medium">Held</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((credit) => (
                <tr key={credit.paymentId} className="border-t border-line/60">
                  <td className="py-1">{credit.customerName}</td>
                  <td className="tnum py-1 text-muted">{credit.paymentDate}</td>
                  <td className="tnum py-1 text-right font-medium">
                    {formatCents(credit.availableCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {canVoid && (
            <div className="mt-4 space-y-3 border-t border-line pt-3">
              <label className="block text-xs text-muted">
                <span className="mb-1 block">Whose credit</span>
                <select
                  value={creditId}
                  onChange={(event) => {
                    setCreditId(event.target.value)
                    setCreditInvoiceId('')
                    setRefundAmount('')
                  }}
                  className="field py-1.5 text-sm"
                >
                  <option value="">Choose…</option>
                  {credits.map((credit) => (
                    <option key={credit.paymentId} value={credit.paymentId}>
                      {credit.customerName} — {formatCents(credit.availableCents)} held
                    </option>
                  ))}
                </select>
              </label>

              {chosenCredit && (
                <div className="flex flex-wrap items-end gap-4">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-xs text-muted">
                      <span className="mb-1 block">Put it against</span>
                      <select
                        value={creditInvoiceId}
                        onChange={(event) => setCreditInvoiceId(event.target.value)}
                        className="field py-1.5 text-sm"
                      >
                        <option value="">
                          {chosenCredit.openInvoices.length === 0
                            ? 'Nothing open for them'
                            : 'Choose…'}
                        </option>
                        {chosenCredit.openInvoices.map((invoice) => (
                          <option key={invoice.id} value={invoice.id}>
                            {invoice.number} — {formatCents(invoice.balanceCents)} outstanding
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn btn-ghost text-sm"
                      disabled={pending || !creditInvoiceId}
                      onClick={() =>
                        act(() =>
                          applyCustomerCreditAction({
                            paymentId: chosenCredit.paymentId,
                            invoiceId: creditInvoiceId,
                            appliedOn: today,
                          }),
                        )
                      }
                    >
                      Apply it
                    </button>
                  </div>

                  {/* Or give it back. A refund is not a void: the money did
                      arrive, and the customer's bank statement says so. */}
                  <div className="flex flex-wrap items-end gap-2 border-l border-line pl-4">
                    <label className="text-xs text-muted">
                      <span className="mb-1 block">Or refund</span>
                      <input
                        value={refundAmount}
                        onChange={(event) => setRefundAmount(event.target.value)}
                        placeholder={(chosenCredit.availableCents / 100).toFixed(2)}
                        className="field w-28 py-1.5 text-right text-sm tnum"
                      />
                    </label>
                    <label className="text-xs text-muted">
                      <span className="mb-1 block">Out of</span>
                      <select
                        value={refundAccountId}
                        onChange={(event) => setRefundAccountId(event.target.value)}
                        className="field py-1.5 text-sm"
                      >
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name}
                            {account.mask ? ` ••${account.mask}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-muted">
                      <span className="mb-1 block">Reference</span>
                      <input
                        value={refundReference}
                        onChange={(event) => setRefundReference(event.target.value)}
                        placeholder="BACS refund"
                        className="field w-32 py-1.5 text-sm"
                      />
                    </label>
                    <button
                      className="btn btn-ghost text-sm"
                      disabled={pending || !refundAccountId}
                      onClick={() => {
                        const typed = refundAmount.trim()
                          ? parseAmountToCents(refundAmount)
                          : chosenCredit.availableCents

                        if (typed === null) {
                          setNotice({ ok: false, text: `“${refundAmount}” is not an amount.` })
                          return
                        }

                        act(() =>
                          refundCustomerCreditAction({
                            paymentId: chosenCredit.paymentId,
                            amountCents: typed,
                            financialAccountId: refundAccountId,
                            refundedOn: today,
                            reference: refundReference || undefined,
                          }),
                        )
                      }}
                    >
                      Give it back
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {rows.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-muted">
          Nothing has been received or paid yet. Payments recorded under{' '}
          <strong>Invoices &amp; bills</strong> and <strong>What we owe</strong> appear here.
        </p>
      ) : (
        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Who</th>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 font-medium">Settled</th>
                  <th className="px-4 py-2 font-medium">Advised</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  {canVoid && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = openId === row.id
                  const voided = row.status === 'void'

                  return (
                    <Fragment key={row.id}>
                      <tr className={`border-t border-line ${voided ? 'text-faint' : ''}`}>
                        <td className="tnum whitespace-nowrap px-4 py-1.5">{row.paymentDate}</td>
                        <td className="px-4 py-1.5">
                          {row.partyName ?? '—'}
                          <span className="block text-xs text-faint">
                            {row.kind === 'receipt' ? 'received' : 'paid out'}
                          </span>
                        </td>
                        <td className="px-4 py-1.5 text-muted">
                          {row.reference || '—'}
                          {/* Why, on the row. A void with no reason is a hole
                              somebody reconstructs from dates months later. */}
                          {voided && row.voidReason && (
                            <span className="block text-xs text-danger">
                              taken back — {row.voidReason}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-xs text-muted">
                          {row.restorations.length === 0
                            ? '—'
                            : row.restorations.map((r) => r.number).join(', ')}
                        </td>
                        {/*
                          Only money going out can be advised — a remittance
                          sent to a customer would tell them the business had
                          paid *them* (Phase 58).
                        */}
                        <td className="px-4 py-1.5 text-xs">
                          {row.kind !== 'disbursement' ? (
                            <span className="text-faint">—</span>
                          ) : row.remittanceSentAt ? (
                            <span className="text-muted">
                              {row.remittanceSentAt}
                              {row.remittanceSendCount > 1 && (
                                <span className="text-faint">
                                  {' '}
                                  · {row.remittanceSendCount} times
                                </span>
                              )}
                            </span>
                          ) : voided ? (
                            <span className="text-faint">—</span>
                          ) : (
                            <span className="text-faint">not sent</span>
                          )}
                        </td>
                        <td
                          className={`tnum px-4 py-1.5 text-right ${voided ? 'line-through' : ''}`}
                        >
                          {formatCents(row.amountCents)}
                        </td>
                        {canVoid && (
                          <td className="whitespace-nowrap px-4 py-1.5 text-right">
                            {/*
                              Advising a supplier is not the same act as voiding
                              a payment, and needs less: it describes money that
                              has already gone (Phase 58).
                            */}
                            {row.kind === 'disbursement' && !voided && (
                              <>
                                <button
                                  className="btn btn-ghost text-xs"
                                  disabled={pending}
                                  onClick={() =>
                                    act(() => sendRemittanceAction({ paymentId: row.id }))
                                  }
                                >
                                  {row.remittanceSentAt ? 'Advise again' : 'Advise'}
                                </button>
                                <button
                                  className="btn btn-ghost text-xs"
                                  disabled={pending}
                                  onClick={() =>
                                    act(() => shareRemittanceAction({ paymentId: row.id }))
                                  }
                                >
                                  Get link
                                </button>
                              </>
                            )}
                            {row.verdict.ok ? (
                              <CorrectionButton
                                kind="payment.void"
                                open={open}
                                onClick={() => {
                                  setNotice(null)
                                  setOpenId(open ? null : row.id)
                                }}
                              />
                            ) : (
                              /* The refusal is on the row rather than behind a
                                 button that fails when pressed — Phase 47's
                                 rule, and here it is usually somebody else's
                                 record that has the money. */
                              <span
                                className="text-xs text-faint"
                                title={row.verdict.why}
                              >
                                {voided ? 'voided' : 'cannot be undone'}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>

                      {open && row.verdict.ok && (
                        <tr className="border-t border-line bg-raised/40">
                          <td colSpan={canVoid ? 7 : 6} className="px-4 py-3">
                            <CorrectionPanel
                              kind="payment.void"
                              pending={pending}
                              confirmSuffix={formatCents(row.amountCents)}
                              onConfirm={(reason) =>
                                act(() => voidPaymentAction({ paymentId: row.id, reason }))
                              }
                            >
                              <span className="text-ink">{row.verdict.why}</span>

                              {row.restorations.length > 0 && (
                                <ul className="mt-2 space-y-0.5">
                                  {row.restorations.map((r) => (
                                    <li key={r.number}>
                                      <strong>{r.number}</strong> goes back to{' '}
                                      <span className="tnum">{formatCents(r.amountCents)}</span> owed
                                      <span className="text-faint"> — {r.status}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </CorrectionPanel>
                          </td>
                        </tr>
                      )}

                      {/* The refusal in full, for a row that cannot be undone.
                          Shown rather than hidden in a tooltip, because it names
                          the record that has the money and what to do there. */}
                      {!row.verdict.ok && !voided && canVoid && (
                        <tr className="border-t border-line/60">
                          {/* Only rendered when `canVoid`, so the row always
                              carries the trailing action column too. */}
                          <td colSpan={7} className="px-4 pb-2 text-xs text-muted">
                            {row.verdict.why}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
