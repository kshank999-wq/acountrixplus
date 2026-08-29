'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setVendorReportingAction } from '@/app/actions/payroll'
import { formatCents } from '@/lib/money'

type Row = {
  vendorId: string
  vendorName: string
  isReportable: boolean
  hasTaxId: boolean
  paidCents: number
  paymentCount: number
  meetsThreshold: boolean
  blockers: string[]
}

/**
 * The contractor report, with the blockers column doing the work.
 *
 * The figure is the easy part. What actually stops a filing in January is a
 * missing tax identifier on somebody who was paid nine months ago and no
 * longer answers the phone — so the column that names the problem sits beside
 * the amount rather than behind a drill-down.
 */
export function ContractorTable({
  year,
  rows,
  canManage,
}: {
  year: number
  rows: Row[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [taxId, setTaxId] = useState('')

  function save(vendorId: string, isReportable: boolean, withTaxId: boolean) {
    startTransition(async () => {
      const result = await setVendorReportingAction({
        vendorId,
        isReportable,
        ...(withTaxId ? { taxId } : {}),
      })

      setMessage({ text: result.ok ? (result.message ?? 'Saved.') : result.error, ok: result.ok })

      if (result.ok) {
        setEditing(null)
        setTaxId('')
        router.refresh()
      }
    })
  }

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Contractors paid in {year}</h2>
        <p className="text-xs text-muted">
          A contractor’s identifier is stored whole, unlike an employee’s — the report needs the
          full number and there is nowhere else it lives. That is a real difference in exposure,
          which is why editing it needs permission to manage tax rather than merely to see it.
        </p>
      </header>

      {message && (
        <p
          className={`border-b border-line px-4 py-2 text-xs ${
            message.ok ? 'text-positive' : 'text-negative'
          }`}
        >
          {message.text}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          Nobody was paid enough to report, and no vendor is marked reportable.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Vendor</th>
                <th className="px-4 py-2 text-right font-medium">Paid</th>
                <th className="px-4 py-2 text-right font-medium">Payments</th>
                <th className="px-4 py-2 font-medium">Tax id</th>
                <th className="px-4 py-2 font-medium">What is stopping it</th>
                {canManage && <th className="px-4 py-2 font-medium" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.vendorId} className="border-t border-line align-top">
                  <td className="px-4 py-2">
                    <span className="font-medium">{row.vendorName}</span>
                    {row.meetsThreshold && (
                      <span className="ml-2 chip bg-brand/15 px-2 py-0.5 text-[11px] text-action">
                        reportable
                      </span>
                    )}
                    {!row.isReportable && (
                      <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                        not flagged
                      </span>
                    )}
                  </td>
                  <td className="tnum px-4 py-2 text-right">{formatCents(row.paidCents)}</td>
                  <td className="tnum px-4 py-2 text-right text-muted">{row.paymentCount}</td>
                  <td className="px-4 py-2 text-muted">
                    {row.hasTaxId ? (
                      <span className="text-positive">on file</span>
                    ) : (
                      <span className="text-faint">none</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {row.blockers.length === 0 ? (
                      <span className="text-faint">Ready.</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {row.blockers.map((blocker) => (
                          <li
                            key={blocker}
                            className={row.meetsThreshold ? 'text-negative' : 'text-warning'}
                          >
                            {blocker}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>

                  {canManage && (
                    <td className="px-4 py-2">
                      {editing === row.vendorId ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className="field w-40"
                            placeholder="Tax identifier"
                            value={taxId}
                            onChange={(event) => setTaxId(event.target.value)}
                          />
                          <button
                            className="btn btn-primary px-2 py-1 text-xs"
                            disabled={pending}
                            onClick={() => save(row.vendorId, true, true)}
                          >
                            Save
                          </button>
                          <button
                            className="btn px-2 py-1 text-xs"
                            onClick={() => {
                              setEditing(null)
                              setTaxId('')
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="btn px-2 py-1 text-xs"
                            onClick={() => {
                              setEditing(row.vendorId)
                              setTaxId('')
                            }}
                          >
                            {row.hasTaxId ? 'Replace id' : 'Add id'}
                          </button>
                          <button
                            className="btn px-2 py-1 text-xs"
                            disabled={pending}
                            onClick={() => save(row.vendorId, !row.isReportable, false)}
                          >
                            {row.isReportable ? 'Unflag' : 'Mark reportable'}
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-line px-4 py-3 text-xs text-faint">
        Setting an identifier records that one was set. The number itself never enters the audit
        log, which is read by everybody with permission to see it.
      </p>
    </section>
  )
}
