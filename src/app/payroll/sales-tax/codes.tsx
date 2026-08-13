'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createTaxCodeAction } from '@/app/actions/payroll'

type Code = {
  id: string
  code: string
  name: string
  jurisdiction: string
  rateBp: number
  isExempt: boolean
  isActive: boolean
  effectiveFrom: string | null
}

/**
 * The codes a company is registered for.
 *
 * There is no shipped rate table and there will not be one. A rate table in a
 * release is correct on the day it ships and silently wrong afterwards, and
 * "silently wrong but authoritative-looking" is the worst state for a number
 * somebody is about to remit against. The rates here came from the company's
 * jurisdictions, and the company owns them.
 */
export function TaxCodes({ codes, canManage }: { codes: Code[]; canManage: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [open, setOpen] = useState(false)

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [jurisdiction, setJurisdiction] = useState('')
  const [rate, setRate] = useState('')
  const [isExempt, setIsExempt] = useState(false)
  const [effectiveFrom, setEffectiveFrom] = useState('')

  function submit() {
    const percent = Number(rate)
    if (!Number.isFinite(percent)) {
      setMessage({ text: 'Enter the rate as a percentage, e.g. 8.25.', ok: false })
      return
    }

    startTransition(async () => {
      const result = await createTaxCodeAction({
        code,
        name,
        jurisdiction,
        // Percent in, basis points stored. Rounded here so 8.25 becomes exactly
        // 825 rather than 824.9999999 via floating point.
        rateBp: Math.round(percent * 100),
        isExempt,
        effectiveFrom,
      })

      setMessage({ text: result.ok ? (result.message ?? 'Added.') : result.error, ok: result.ok })

      if (result.ok) {
        setCode('')
        setName('')
        setRate('')
        setEffectiveFrom('')
        setOpen(false)
        router.refresh()
      }
    })
  }

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Tax codes</h2>
          <p className="text-xs text-muted">
            Rates are yours, not ours. Nothing is shipped and nothing updates itself — a rate that
            changes without anybody deciding it should is worse than no rate at all.
          </p>
        </div>
        {canManage && (
          <button className="btn text-xs" onClick={() => setOpen((value) => !value)}>
            {open ? 'Cancel' : 'Add a code'}
          </button>
        )}
      </header>

      {open && canManage && (
        <div className="space-y-2 border-b border-line p-4">
          <div className="flex flex-wrap gap-2">
            <input
              className="field w-32"
              placeholder="Code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <input
              className="field flex-1 min-w-48"
              placeholder="Name, e.g. State and county combined"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="field w-48"
              placeholder="Jurisdiction"
              value={jurisdiction}
              onChange={(event) => setJurisdiction(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-muted">
              Rate
              <input
                className="field ml-1 inline-block w-24 text-right"
                placeholder="8.25"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
              />
              <span className="ml-1">%</span>
            </label>
            <label className="text-xs text-muted">
              Effective from
              <input
                className="field ml-1 inline-block w-40"
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={isExempt}
                onChange={(event) => setIsExempt(event.target.checked)}
              />
              Exempt code (sales tracked, no tax charged)
            </label>
            <button className="btn btn-primary text-xs" disabled={pending} onClick={submit}>
              {pending ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={`border-b border-line px-4 py-2 text-xs ${
            message.ok ? 'text-positive' : 'text-negative'
          }`}
        >
          {message.text}
        </p>
      )}

      {codes.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          No tax codes yet. Add the ones you are registered for.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Jurisdiction</th>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 text-right font-medium">Rate</th>
                <th className="px-4 py-2 font-medium">From</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((entry) => (
                <tr key={entry.id} className="border-t border-line">
                  <td className="px-4 py-1.5 font-medium">{entry.jurisdiction}</td>
                  <td className="px-4 py-1.5">
                    <span className={entry.isActive ? '' : 'text-faint line-through'}>
                      {entry.code}
                    </span>
                    {entry.isExempt && (
                      <span className="ml-2 chip bg-raised px-2 py-0.5 text-[11px] text-muted">
                        exempt
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{entry.name}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {entry.rateBp / 100}%
                  </td>
                  <td className="px-4 py-1.5 text-muted">{entry.effectiveFrom ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-line px-4 py-3 text-xs text-faint">
        Changing a rate applies to invoices raised afterwards. Documents already issued keep the
        rate that was in force when they were raised, so last quarter’s return does not move
        because this quarter’s rate did.
      </p>
    </section>
  )
}
