'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createEmployeeAction } from '@/app/actions/payroll'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Person = {
  id: string
  name: string
  reference: string | null
  email: string | null
  workerType: string
  payBasis: string
  baseRateCents: number
  taxIdLast4: string | null
  startDate: string | null
  isActive: boolean
}

/**
 * The payroll roster.
 *
 * The tax identifier field takes four characters and says why. Every other
 * system asks for the whole number and stores it, which is how a small
 * business ends up holding a table of tax identifiers it has no way to
 * protect — this one cannot leak what it never took.
 */
export function Roster({ people, canManage }: { people: Person[]; canManage: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [open, setOpen] = useState(false)

  const [name, setName] = useState('')
  const [reference, setReference] = useState('')
  const [email, setEmail] = useState('')
  const [workerType, setWorkerType] = useState<'employee' | 'contractor'>('employee')
  const [payBasis, setPayBasis] = useState<'salary' | 'hourly'>('salary')
  const [rate, setRate] = useState('')
  const [taxIdLast4, setTaxIdLast4] = useState('')
  const [startDate, setStartDate] = useState('')

  function submit() {
    let baseRateCents = 0
    try {
      baseRateCents = rate.trim() ? parseAmountToCents(rate) : 0
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Bad amount.', ok: false })
      return
    }

    startTransition(async () => {
      const result = await createEmployeeAction({
        name,
        reference,
        email,
        workerType,
        payBasis,
        baseRateCents,
        taxIdLast4,
        startDate,
      })

      setMessage({
        text: result.ok ? (result.message ?? 'Added.') : result.error,
        ok: result.ok,
      })

      if (result.ok) {
        setName('')
        setReference('')
        setEmail('')
        setRate('')
        setTaxIdLast4('')
        setStartDate('')
        setOpen(false)
        router.refresh()
      }
    })
  }

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">People on payroll</h2>
          <p className="text-xs text-muted">
            A salary rate is annual and a hourly rate is per hour; the run works out which applies
            from the length of the pay period, so a fortnightly run cannot be paid at a monthly
            rate because a dropdown said so.
          </p>
        </div>
        {canManage && (
          <button className="btn text-xs" onClick={() => setOpen((value) => !value)}>
            {open ? 'Cancel' : 'Add somebody'}
          </button>
        )}
      </header>

      {open && canManage && (
        <div className="space-y-2 border-b border-line p-4">
          <div className="flex flex-wrap gap-2">
            <input
              className="field flex-1 min-w-48"
              placeholder="Full name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="field w-36"
              placeholder="Reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <input
              className="field w-56"
              placeholder="Email (optional)"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <select
              className="field w-40"
              value={workerType}
              onChange={(event) => setWorkerType(event.target.value as 'employee' | 'contractor')}
            >
              <option value="employee">Employee</option>
              <option value="contractor">Contractor</option>
            </select>
            <select
              className="field w-40"
              value={payBasis}
              onChange={(event) => setPayBasis(event.target.value as 'salary' | 'hourly')}
            >
              <option value="salary">Salary (annual)</option>
              <option value="hourly">Hourly</option>
            </select>
            <input
              className="field w-40"
              placeholder={payBasis === 'salary' ? 'Annual salary' : 'Rate per hour'}
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
            <input
              className="field w-32"
              placeholder="Start date"
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              className="field w-28"
              placeholder="Tax id ••••"
              maxLength={4}
              value={taxIdLast4}
              onChange={(event) => setTaxIdLast4(event.target.value)}
            />
            <p className="text-xs text-faint">
              Last four digits only, so a payslip can be matched to a bureau report. This system
              does not store full tax identifiers for employees and will refuse a longer value
              rather than quietly trimming it.
            </p>
          </div>

          <div className="flex items-center gap-3">
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

      {people.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          Nobody on payroll yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Basis</th>
                <th className="px-4 py-2 text-right font-medium">Rate</th>
                <th className="px-4 py-2 font-medium">Tax id</th>
                <th className="px-4 py-2 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    <span className={person.isActive ? 'font-medium' : 'text-faint line-through'}>
                      {person.name}
                    </span>
                    {person.reference && (
                      <span className="ml-2 text-xs text-faint">{person.reference}</span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{person.workerType}</td>
                  <td className="px-4 py-1.5 text-muted">{person.payBasis}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(person.baseRateCents)}
                    <span className="ml-1 text-xs text-faint">
                      {person.payBasis === 'salary' ? '/yr' : '/hr'}
                    </span>
                  </td>
                  <td className="px-4 py-1.5 text-muted">
                    {person.taxIdLast4 ? `•••• ${person.taxIdLast4}` : <span className="text-faint">—</span>}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{person.startDate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
