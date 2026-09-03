'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { putRateAction, type ActionResult } from '@/app/actions/fx'
import { formatCents } from '@/lib/money'

type RateRow = {
  id: string
  baseCurrency: string
  quoteCurrency: string
  rateDate: string
  rateMillionths: number
  source: string
}

type ExposureRow = {
  party: string
  documentNumber: string
  currency: string
  outstandingCents: number
  documentRateMillionths: number
  carriedCents: number
  restatedCents: number
  unrealisedCents: number
}

type Exposure = {
  asOf: string
  functionalCurrency: string
  byCurrency: Array<{
    currency: string
    closingRateMillionths: number
    outstandingCents: number
    carriedCents: number
    restatedCents: number
    unrealisedCents: number
  }>
  receivables: ExposureRow[]
  payables: ExposureRow[]
  netUnrealisedCents: number
  noExposure: boolean
}

/** 1_083_500 → "1.083500". Six places, always, so a column of them lines up. */
function rateText(millionths: number): string {
  return (millionths / 1_000_000).toFixed(6)
}

/**
 * Currencies: the rates, and what the open foreign balances are worth.
 *
 * ## Both numbers, everywhere
 *
 * Every foreign amount on this page appears twice — what the document says, and
 * what the books carry it at. Showing only one is how somebody comes to believe
 * a €4,000 invoice is a $4,000 one; showing only the other is how they lose the
 * ability to check it against the paper the customer holds.
 */
export function CurrencyBoard({
  functionalCurrency,
  asOf,
  rates,
  currenciesInUse,
  exposure,
  exposureError,
  realised,
  canEnterRates,
  canSeeExposure,
}: {
  functionalCurrency: string
  asOf: string
  rates: RateRow[]
  currenciesInUse: string[]
  exposure: Exposure | null
  exposureError: string | null
  realised: { accountNumber: string; realisedCents: number; hasAccount: boolean } | null
  canEnterRates: boolean
  canSeeExposure: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [currency, setCurrency] = useState(currenciesInUse[0] ?? '')
  const [rateDate, setRateDate] = useState(asOf)
  const [rate, setRate] = useState('')
  const [source, setSource] = useState('')

  function submit() {
    startTransition(async () => {
      const result: ActionResult = await putRateAction({
        baseCurrency: currency,
        rateDate,
        rate,
        source: source || undefined,
      })

      setNotice(
        result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error },
      )

      if (result.ok) {
        setRate('')
        router.refresh()
      }
    })
  }

  const money = (cents: number, code = functionalCurrency) => formatCents(cents, code)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Currencies</h2>
        <p className="text-sm text-muted">
          These books are kept in <strong className="text-ink">{functionalCurrency}</strong>.{' '}
          <span className="text-faint">
            A document raised in another currency is owed in that currency and carried in this one,
            at the rate on the day it was raised. That rate never changes afterwards.
          </span>
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {canEnterRates && (
        <section className="card px-4 py-4">
          <h3 className="text-sm font-semibold">Record a rate</h3>
          <p className="mt-1 text-xs text-muted">
            One rate per currency per day. Entering a second for the same day replaces the first —
            a correction, not a second opinion.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Currency</span>
              <input
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                placeholder="EUR"
                maxLength={3}
                className="field w-24 py-1.5 text-sm uppercase"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Day</span>
              <input
                type="date"
                value={rateDate}
                onChange={(event) => setRateDate(event.target.value)}
                className="field py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">
                1 {currency || 'XXX'} buys, in {functionalCurrency}
              </span>
              <input
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                placeholder="1.0835"
                inputMode="decimal"
                className="field w-32 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Where it came from</span>
              <input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="ECB"
                className="field w-40 py-1.5 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !currency || !rate}
              className="btn btn-primary py-1.5 text-sm"
            >
              {pending ? 'Recording…' : 'Record'}
            </button>
          </div>
        </section>
      )}

      {realised?.hasAccount && (
        <section className="card px-4 py-4">
          <h3 className="text-sm font-semibold">What currency has already done</h3>
          <p className="mt-1 text-sm">
            <span
              className={
                realised.realisedCents === 0
                  ? 'text-muted'
                  : realised.realisedCents > 0
                    ? 'text-success'
                    : 'text-danger'
              }
            >
              {money(realised.realisedCents)}
            </span>{' '}
            <span className="text-muted">
              realised, in account {realised.accountNumber}. This is settled and in the profit and
              loss — documents that were paid at a rate other than the one they were raised at.
            </span>
          </p>
        </section>
      )}

      {canSeeExposure && (
        <section className="card px-4 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">What the open balances are worth</h3>
              <p className="mt-1 text-xs text-muted">
                Reported, never posted. Nobody has been paid, and the rate can move back before they
                are — anybody who wants this in the ledger can post the entry it describes.
              </p>
            </div>
            <label className="text-xs text-muted">
              <span className="mb-1 block">At the rate on</span>
              <input
                type="date"
                value={asOf}
                onChange={(event) =>
                  router.push(`/accounting/currencies?asOf=${event.target.value}`)
                }
                className="field py-1.5 text-sm"
              />
            </label>
          </div>

          {exposureError ? (
            <p className="mt-3 text-sm text-danger">{exposureError}</p>
          ) : exposure === null || exposure.noExposure ? (
            <p className="mt-3 text-sm text-muted">
              Nothing is open in a currency other than {functionalCurrency}. There is no exposure to
              report.
            </p>
          ) : (
            <div className="mt-3 space-y-5">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line text-left">
                      <th className="py-1.5 pr-3">Currency</th>
                      <th className="py-1.5 pr-3">Rate on {exposure.asOf}</th>
                      <th className="py-1.5 pr-3 text-right">Still owed</th>
                      <th className="py-1.5 pr-3 text-right">Carried at</th>
                      <th className="py-1.5 pr-3 text-right">Worth today</th>
                      <th className="py-1.5 text-right">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exposure.byCurrency.map((row) => (
                      <tr key={row.currency} className="border-b border-line/50">
                        <td className="py-1.5 pr-3 font-medium">{row.currency}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-muted">
                          {rateText(row.closingRateMillionths)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {money(row.outstandingCents, row.currency)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {money(row.carriedCents)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {money(row.restatedCents)}
                        </td>
                        <td
                          className={`py-1.5 text-right tabular-nums ${
                            row.unrealisedCents === 0
                              ? 'text-muted'
                              : row.unrealisedCents > 0
                                ? 'text-success'
                                : 'text-danger'
                          }`}
                        >
                          {money(row.unrealisedCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-medium">
                      <td className="py-1.5 pr-3" colSpan={5}>
                        Net, across everything open
                      </td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${
                          exposure.netUnrealisedCents === 0
                            ? 'text-muted'
                            : exposure.netUnrealisedCents > 0
                              ? 'text-success'
                              : 'text-danger'
                        }`}
                      >
                        {money(exposure.netUnrealisedCents)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {(
                [
                  ['Owed to us', exposure.receivables],
                  ['Owed by us', exposure.payables],
                ] as const
              )
                .filter(([, rows]) => rows.length > 0)
                .map(([heading, rows]) => (
                  <div key={heading}>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                      {heading}
                    </h4>
                    <div className="mt-1.5 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted">
                          <tr className="border-b border-line text-left">
                            <th className="py-1.5 pr-3">Document</th>
                            <th className="py-1.5 pr-3">Who</th>
                            <th className="py-1.5 pr-3 text-right">Still owed</th>
                            <th className="py-1.5 pr-3">Raised at</th>
                            <th className="py-1.5 pr-3 text-right">Carried at</th>
                            <th className="py-1.5 text-right">Worth today</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.documentNumber} className="border-b border-line/50">
                              <td className="py-1.5 pr-3 font-medium">{row.documentNumber}</td>
                              <td className="py-1.5 pr-3 text-muted">{row.party}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">
                                {money(row.outstandingCents, row.currency)}
                              </td>
                              <td className="py-1.5 pr-3 tabular-nums text-muted">
                                {rateText(row.documentRateMillionths)}
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">
                                {money(row.carriedCents)}
                              </td>
                              <td className="py-1.5 text-right tabular-nums">
                                {money(row.restatedCents)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      <section className="card px-4 py-4">
        <h3 className="text-sm font-semibold">Rates on file</h3>
        {rates.length === 0 ? (
          <p className="mt-1 text-sm text-muted">
            None yet. A document in another currency will refuse to post until there is a rate for
            its day or an earlier one — guessing parity would book the wrong number and look right.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line text-left">
                  <th className="py-1.5 pr-3">Day</th>
                  <th className="py-1.5 pr-3">Pair</th>
                  <th className="py-1.5 pr-3 text-right">Rate</th>
                  <th className="py-1.5">Where it came from</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((row) => (
                  <tr key={row.id} className="border-b border-line/50">
                    <td className="py-1.5 pr-3 tabular-nums">{row.rateDate}</td>
                    <td className="py-1.5 pr-3">
                      {row.baseCurrency}/{row.quoteCurrency}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {rateText(row.rateMillionths)}
                    </td>
                    <td className="py-1.5 text-muted">{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
