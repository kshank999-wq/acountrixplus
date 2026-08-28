'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { voidPaymentAction, type ActionResult } from '@/app/actions/payables'
import type { VoidVerdict } from '@/modules/receivables/payment-void'
import { formatCents } from '@/lib/money'

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
}

/**
 * Money in and out (Phase 52).
 *
 * Payments were recorded from two screens and never listed again, and there was
 * no way to take one back at all — no status column on `payments`, no service
 * function, nothing. A receipt keyed at ten times its amount was permanent.
 */
export function PaymentsBoard({ rows, canVoid }: { rows: Row[]; canVoid: boolean }) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const [openId, setOpenId] = useState<string | null>(null)
  const [reason, setReason] = useState('')

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
        setReason('')
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
                        <td
                          className={`tnum px-4 py-1.5 text-right ${voided ? 'line-through' : ''}`}
                        >
                          {formatCents(row.amountCents)}
                        </td>
                        {canVoid && (
                          <td className="px-4 py-1.5 text-right">
                            {row.verdict.ok ? (
                              <button
                                className="btn btn-ghost text-xs"
                                onClick={() => {
                                  setNotice(null)
                                  setOpenId(open ? null : row.id)
                                  setReason('')
                                }}
                              >
                                {open ? 'Cancel' : 'Take it back'}
                              </button>
                            ) : (
                              /* The refusal is on the row rather than behind a
                                 button that fails when pressed — Phase 47's
                                 rule, and here it is usually somebody else's
                                 record that has the money. */
                              <span
                                className="text-xs text-faint"
                                title={row.verdict.why}
                              >
                                {voided ? 'taken back' : 'cannot be undone'}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>

                      {open && row.verdict.ok && (
                        <tr className="border-t border-line bg-raised/40">
                          <td colSpan={canVoid ? 6 : 5} className="px-4 py-3">
                            <p className="text-sm">{row.verdict.why}</p>

                            {row.restorations.length > 0 && (
                              <ul className="mt-2 space-y-0.5 text-xs text-muted">
                                {row.restorations.map((r) => (
                                  <li key={r.number}>
                                    <strong>{r.number}</strong> goes back to{' '}
                                    <span className="tnum">{formatCents(r.amountCents)}</span> owed
                                    <span className="text-faint"> — {r.status}</span>
                                  </li>
                                ))}
                              </ul>
                            )}

                            <div className="mt-3 flex flex-wrap items-end gap-2">
                              <label className="flex-1 text-xs text-muted">
                                <span className="mb-1 block">Why</span>
                                <input
                                  value={reason}
                                  onChange={(event) => setReason(event.target.value)}
                                  placeholder="Keyed at ten times the amount"
                                  className="field w-full py-1.5 text-sm"
                                />
                              </label>
                              <button
                                className="btn btn-primary text-sm"
                                disabled={pending || !reason.trim()}
                                onClick={() =>
                                  act(() =>
                                    voidPaymentAction({ paymentId: row.id, reason }),
                                  )
                                }
                              >
                                Take back {formatCents(row.amountCents)}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}

                      {/* The refusal in full, for a row that cannot be undone.
                          Shown rather than hidden in a tooltip, because it names
                          the record that has the money and what to do there. */}
                      {!row.verdict.ok && !voided && canVoid && (
                        <tr className="border-t border-line/60">
                          <td colSpan={6} className="px-4 pb-2 text-xs text-muted">
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
