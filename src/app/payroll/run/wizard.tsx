'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  calculatePayrollAction,
  postPayrollRunAction,
  previewPayrollAction,
} from '@/app/actions/payroll'
import { formatCents, parseAmountToCents } from '@/lib/money'
import {
  PAYROLL_KINDS,
  PAYROLL_KIND_EFFECT,
  PAYROLL_KIND_LABELS,
} from '@/modules/payroll/vocabulary'
import type { PayrollLineKind } from '@/modules/payroll/provider'
import { messageFor } from '@/modules/errors'

type Person = {
  id: string
  name: string
  payBasis: 'salary' | 'hourly'
  baseRateCents: number
}

type ProviderStatus = {
  key: string
  label: string
  calculates: boolean
  configured: boolean
}

type DraftLine = {
  kind: PayrollLineKind
  label: string
  amount: string
  agency: string
}

type DraftSlip = {
  employeeId: string
  hours: string
  lines: DraftLine[]
}

type Preview = Awaited<ReturnType<typeof previewPayrollAction>>

/**
 * Three steps: the period, the figures, the entry.
 *
 * The third is not a confirmation dialog. It is the entry, itemised, with the
 * identity `gross + employer cost = net + everything owed` shown as arithmetic
 * rather than asserted — because the person posting is the only one who can
 * tell whether a line was kinded wrongly, and they can only tell by looking at
 * where it landed.
 */
export function RunWizard({
  people,
  providers,
  activeProviderKey,
}: {
  people: Person[]
  providers: ProviderStatus[]
  activeProviderKey: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [payDate, setPayDate] = useState('')
  const [frequency, setFrequency] = useState<'weekly' | 'biweekly' | 'semimonthly' | 'monthly'>(
    'monthly',
  )
  const [memo, setMemo] = useState('')
  const [sourceReference, setSourceReference] = useState('')
  const [providerKey, setProviderKey] = useState(activeProviderKey)

  const [isIllustrative, setIsIllustrative] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [slips, setSlips] = useState<DraftSlip[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)

  const byId = useMemo(() => new Map(people.map((person) => [person.id, person])), [people])

  const datesReady = Boolean(periodStart && periodEnd && payDate)

  function buildPayload() {
    return {
      periodStart,
      periodEnd,
      payDate,
      frequency,
      memo,
      sourceReference,
      isIllustrative,
      payslips: slips
        .filter((slip) => slip.lines.some((line) => line.amount.trim()))
        .map((slip) => ({
          employeeId: slip.employeeId,
          hoursMilli: slip.hours.trim() ? Math.round(Number(slip.hours) * 1000) : 0,
          lines: slip.lines
            .filter((line) => line.amount.trim())
            .map((line) => ({
              kind: line.kind,
              label: line.label.trim() || PAYROLL_KIND_LABELS[line.kind],
              amountCents: parseAmountToCents(line.amount),
              agency: line.agency.trim() || undefined,
            })),
        })),
    }
  }

  function startBlank() {
    setIsIllustrative(false)
    setNotice(null)
    setSlips(
      people.map((person) => ({
        employeeId: person.id,
        hours: '',
        lines: [{ kind: 'earning', label: 'Salary', amount: '', agency: '' }],
      })),
    )
    setStep(2)
  }

  function askAdapter() {
    startTransition(async () => {
      const result = await calculatePayrollAction({
        periodStart,
        periodEnd,
        payDate,
        providerKey,
        employees: people.map((person) => ({
          id: person.id,
          name: person.name,
          payBasis: person.payBasis,
          baseRateCents: person.baseRateCents,
        })),
      })

      if (!result.ok) {
        // The manual adapter's refusal lands here, and it is the expected path
        // rather than an error: it says to enter the bureau's figures, and the
        // next thing on screen is the form to do that in.
        setMessage({ text: result.error, ok: false })
        startBlank()
        return
      }

      setIsIllustrative(result.illustrative)
      setNotice(result.notice ?? null)
      setMessage(null)
      setSlips(
        result.payslips.map((slip) => ({
          employeeId: slip.employeeId,
          hours: slip.hoursMilli ? String(slip.hoursMilli / 1000) : '',
          lines: slip.lines.map((line) => ({
            kind: line.kind,
            label: line.label,
            amount: (line.amountCents / 100).toFixed(2),
            agency: line.agency ?? '',
          })),
        })),
      )
      setStep(2)
    })
  }

  function toPreview() {
    let payload
    try {
      payload = buildPayload()
    } catch (error) {
      setMessage({ text: messageFor(error, 'Bad amount.'), ok: false })
      return
    }

    if (payload.payslips.length === 0) {
      setMessage({ text: 'Enter at least one amount before continuing.', ok: false })
      return
    }

    startTransition(async () => {
      const result = await previewPayrollAction(payload)
      setPreview(result)
      setMessage(result.ok ? null : { text: result.error, ok: false })
      if (result.ok) setStep(3)
    })
  }

  function post() {
    let payload
    try {
      payload = buildPayload()
    } catch (error) {
      setMessage({ text: messageFor(error, 'Bad amount.'), ok: false })
      return
    }

    startTransition(async () => {
      const result = await postPayrollRunAction(payload)
      setMessage({ text: result.ok ? (result.message ?? 'Posted.') : result.error, ok: result.ok })
      if (result.ok) {
        setStep(1)
        setSlips([])
        setPreview(null)
        router.push('/payroll')
        router.refresh()
      }
    })
  }

  function updateLine(slipIndex: number, lineIndex: number, patch: Partial<DraftLine>) {
    setSlips((current) =>
      current.map((slip, index) =>
        index !== slipIndex
          ? slip
          : {
              ...slip,
              lines: slip.lines.map((line, position) =>
                position === lineIndex ? { ...line, ...patch } : line,
              ),
            },
      ),
    )
  }

  function addLine(slipIndex: number) {
    setSlips((current) =>
      current.map((slip, index) =>
        index !== slipIndex
          ? slip
          : {
              ...slip,
              lines: [...slip.lines, { kind: 'employee_tax', label: '', amount: '', agency: '' }],
            },
      ),
    )
  }

  function removeLine(slipIndex: number, lineIndex: number) {
    setSlips((current) =>
      current.map((slip, index) =>
        index !== slipIndex
          ? slip
          : { ...slip, lines: slip.lines.filter((_, position) => position !== lineIndex) },
      ),
    )
  }

  return (
    <div className="space-y-4">
      <Steps step={step} />

      {message && (
        <p
          className={`card p-3 text-sm ${message.ok ? 'text-positive' : 'text-negative'}`}
          role="status"
        >
          {message.text}
        </p>
      )}

      {step === 1 && (
        <section className="card overflow-hidden">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">The period being paid</h2>
            <p className="text-xs text-muted">
              A salary rate is annual, and the number of periods in a year is worked out from the
              length of this period rather than from the frequency you pick — so dates that say a
              fortnight are paid as a fortnight.
            </p>
          </header>

          <div className="space-y-3 p-4">
            <div className="grid gap-2 sm:grid-cols-4">
              <label className="text-xs text-muted">
                Period start
                <input
                  className="field mt-1"
                  type="date"
                  value={periodStart}
                  onChange={(event) => setPeriodStart(event.target.value)}
                />
              </label>
              <label className="text-xs text-muted">
                Period end
                <input
                  className="field mt-1"
                  type="date"
                  value={periodEnd}
                  onChange={(event) => setPeriodEnd(event.target.value)}
                />
              </label>
              <label className="text-xs text-muted">
                Pay date
                <input
                  className="field mt-1"
                  type="date"
                  value={payDate}
                  onChange={(event) => setPayDate(event.target.value)}
                />
              </label>
              <label className="text-xs text-muted">
                Frequency
                <select
                  className="field mt-1"
                  value={frequency}
                  onChange={(event) =>
                    setFrequency(event.target.value as typeof frequency)
                  }
                >
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Fortnightly</option>
                  <option value="semimonthly">Twice monthly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted">
                Bureau reference (optional)
                <input
                  className="field mt-1"
                  placeholder="The report these figures came from"
                  value={sourceReference}
                  onChange={(event) => setSourceReference(event.target.value)}
                />
              </label>
              <label className="text-xs text-muted">
                Memo (optional)
                <input
                  className="field mt-1"
                  placeholder="Shown on the journal entry"
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                />
              </label>
            </div>

            <div className="rounded-lg border border-line p-3">
              <p className="text-xs font-medium">Where the figures come from</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  className="field w-64"
                  value={providerKey}
                  onChange={(event) => setProviderKey(event.target.value)}
                >
                  {providers.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.key} — {entry.calculates ? 'calculates' : 'records only'}
                    </option>
                  ))}
                </select>
                <button
                  className="btn text-xs"
                  disabled={!datesReady || pending}
                  onClick={askAdapter}
                >
                  Ask the adapter
                </button>
                <button
                  className="btn btn-primary text-xs"
                  disabled={!datesReady || pending}
                  onClick={startBlank}
                >
                  Enter figures by hand
                </button>
              </div>
              <p className="mt-2 text-xs text-faint">
                {providers.find((entry) => entry.key === providerKey)?.label}
              </p>
            </div>
          </div>
        </section>
      )}

      {step === 2 && (
        <>
          {isIllustrative && (
            <p className="card border-negative/40 p-4 text-sm">
              <span className="font-medium text-negative">These are not real tax rates.</span>{' '}
              {notice ??
                'The illustrative adapter uses invented flat percentages that match no jurisdiction.'}{' '}
              The run will be stored marked illustrative, every report will say so, and it will
              block a filing.
            </p>
          )}

          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">The figures</h2>
                <p className="text-xs text-muted">
                  Every amount is positive. The kind carries the direction — which is also what
                  decides whether it becomes a cost or a liability.
                </p>
              </div>
              <div className="flex gap-2">
                <button className="btn text-xs" onClick={() => setStep(1)}>
                  Back
                </button>
                <button className="btn btn-primary text-xs" disabled={pending} onClick={toPreview}>
                  {pending ? 'Working…' : 'Show me the entry'}
                </button>
              </div>
            </header>

            <div className="divide-y divide-line">
              {slips.map((slip, slipIndex) => {
                const person = byId.get(slip.employeeId)
                if (!person) return null

                return (
                  <div key={slip.employeeId} className="p-4">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{person.name}</p>
                        <p className="text-xs text-faint">
                          {person.payBasis === 'salary'
                            ? `${formatCents(person.baseRateCents)} a year`
                            : `${formatCents(person.baseRateCents)} an hour`}
                        </p>
                      </div>
                      {person.payBasis === 'hourly' && (
                        <label className="text-xs text-muted">
                          Hours{' '}
                          <input
                            className="field ml-1 inline-block w-24"
                            placeholder="0"
                            value={slip.hours}
                            onChange={(event) =>
                              setSlips((current) =>
                                current.map((entry, index) =>
                                  index === slipIndex
                                    ? { ...entry, hours: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                        </label>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      {slip.lines.map((line, lineIndex) => (
                        <div key={lineIndex} className="flex flex-wrap items-center gap-2">
                          <select
                            className="field w-64"
                            value={line.kind}
                            onChange={(event) =>
                              updateLine(slipIndex, lineIndex, {
                                kind: event.target.value as PayrollLineKind,
                              })
                            }
                          >
                            {PAYROLL_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {PAYROLL_KIND_LABELS[kind]}
                              </option>
                            ))}
                          </select>
                          <input
                            className="field flex-1 min-w-40"
                            placeholder="Label, e.g. Income tax withheld"
                            value={line.label}
                            onChange={(event) =>
                              updateLine(slipIndex, lineIndex, { label: event.target.value })
                            }
                          />
                          <input
                            className="field w-32 text-right"
                            placeholder="0.00"
                            value={line.amount}
                            onChange={(event) =>
                              updateLine(slipIndex, lineIndex, { amount: event.target.value })
                            }
                          />
                          {line.kind !== 'earning' && (
                            <input
                              className="field w-44"
                              placeholder="Agency (optional)"
                              value={line.agency}
                              onChange={(event) =>
                                updateLine(slipIndex, lineIndex, { agency: event.target.value })
                              }
                            />
                          )}
                          <button
                            className="btn px-2 py-1 text-xs"
                            onClick={() => removeLine(slipIndex, lineIndex)}
                            aria-label="Remove line"
                          >
                            ×
                          </button>
                          <p className="w-full text-xs text-faint">
                            {PAYROLL_KIND_EFFECT[line.kind]}
                          </p>
                        </div>
                      ))}
                    </div>

                    <button className="btn mt-2 text-xs" onClick={() => addLine(slipIndex)}>
                      Add a line
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}

      {step === 3 && preview?.ok && (
        <EntryPreview
          preview={preview}
          isIllustrative={isIllustrative}
          pending={pending}
          onBack={() => setStep(2)}
          onPost={post}
        />
      )}
    </div>
  )
}

function Steps({ step }: { step: 1 | 2 | 3 }) {
  const labels = ['Period', 'Figures', 'The entry']

  return (
    <ol className="flex gap-2 text-xs">
      {labels.map((label, index) => (
        <li
          key={label}
          className={`chip px-3 py-1 ${
            step === index + 1
              ? 'bg-brand text-brand-ink'
              : step > index + 1
                ? 'bg-raised text-ink'
                : 'bg-raised text-faint'
          }`}
        >
          {index + 1}. {label}
        </li>
      ))}
    </ol>
  )
}

/**
 * The entry, before it exists.
 *
 * Shows the identity as arithmetic. `gross + employer cost` on one side,
 * `net + everything owed to somebody else` on the other, and the two must
 * match — which is the same check `assertBalanced` runs server-side, restated
 * here so the person posting can see *why* it balances rather than being told
 * that it does.
 */
function EntryPreview({
  preview,
  isIllustrative,
  pending,
  onBack,
  onPost,
}: {
  preview: Extract<Preview, { ok: true }>
  isIllustrative: boolean
  pending: boolean
  onBack: () => void
  onPost: () => void
}) {
  const { totals, lines } = preview

  const debits = lines.reduce((sum, line) => sum + line.debitCents, 0)
  const credits = lines.reduce((sum, line) => sum + line.creditCents, 0)

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">The journal entry this will post</h2>
            <p className="text-xs text-muted">
              One entry, on the pay date. Nothing else is written to the ledger.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn text-xs" onClick={onBack}>
              Back to the figures
            </button>
            <button className="btn btn-primary text-xs" disabled={pending} onClick={onPost}>
              {pending ? 'Posting…' : 'Post this payroll'}
            </button>
          </div>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 text-right font-medium">Debit</th>
                <th className="px-4 py-2 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.account} className="border-t border-line align-top">
                  <td className="px-4 py-2">
                    <p className="font-medium">{line.account}</p>
                    <p className="text-xs text-muted">{line.memo}</p>
                  </td>
                  <td className="tnum px-4 py-2 text-right">
                    {line.debitCents > 0 ? formatCents(line.debitCents) : ''}
                  </td>
                  <td className="tnum px-4 py-2 text-right">
                    {line.creditCents > 0 ? formatCents(line.creditCents) : ''}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-line bg-raised/40 font-medium">
                <td className="px-4 py-2">Total</td>
                <td className="tnum px-4 py-2 text-right">{formatCents(debits)}</td>
                <td className="tnum px-4 py-2 text-right">{formatCents(credits)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Why it balances</h2>
        <p className="mt-1 text-xs text-muted">
          Wage expense is <em>gross</em> pay. What is withheld from somebody’s pay is not a cost to
          the employer — it is their money, held on its way to an agency. The employer’s own taxes
          are a cost on top.
        </p>

        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line p-3">
            <dt className="text-xs text-muted">What it costs the employer</dt>
            <dd className="mt-1 space-y-0.5 text-sm">
              <Row label="Gross pay" cents={totals.grossPayCents} />
              <Row label="Employer taxes and contributions" cents={totals.employerCostCents} />
              <Row
                label="Total cost"
                cents={totals.grossPayCents + totals.employerCostCents}
                strong
              />
            </dd>
          </div>

          <div className="rounded-lg border border-line p-3">
            <dt className="text-xs text-muted">Where that money goes</dt>
            <dd className="mt-1 space-y-0.5 text-sm">
              <Row label="Net pay to people" cents={totals.netPayCents} />
              <Row label="Tax withheld from pay" cents={totals.employeeWithholdingCents} />
              <Row label="Other deductions withheld" cents={totals.employeeDeductionCents} />
              <Row label="Employer taxes owed" cents={totals.employerCostCents} />
              <Row
                label="Total"
                cents={
                  totals.netPayCents +
                  totals.employeeWithholdingCents +
                  totals.employeeDeductionCents +
                  totals.employerCostCents
                }
                strong
              />
            </dd>
          </div>
        </dl>

        {isIllustrative && (
          <p className="mt-3 text-xs text-negative">
            These figures are illustrative. Posting is allowed so the ledger machinery can be seen
            working end to end, and the run is stored marked as such — but nobody should be paid
            from them.
          </p>
        )}
      </section>
    </div>
  )
}

function Row({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div
      className={`flex justify-between gap-4 ${strong ? 'border-t border-line pt-1 font-medium' : ''}`}
    >
      <span className={strong ? '' : 'text-muted'}>{label}</span>
      <span className="tnum">{formatCents(cents)}</span>
    </div>
  )
}
