'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { recordRemittanceAction } from '@/app/actions/payroll'
import { formatCents, parseAmountToCents } from '@/lib/money'
import { messageFor } from '@/modules/errors'

type Position = {
  accountId: string
  accountNumber: string
  accountName: string
  balanceCents: number
}

/**
 * Recording a remittance.
 *
 * Shows what the ledger says is owed next to the amount field, and offers to
 * fill it in. The service refuses to remit more than that anyway — over-remitting
 * drives a liability negative, which reads on a balance sheet as the agency
 * owing you money and goes unnoticed for months — but a refusal after the fact
 * is a worse experience than the number being on screen while you type.
 */
export function RemittanceForm({
  positions,
  banks,
  homeCurrency,
}: {
  positions: Position[]
  banks: Array<{ id: string; name: string; mask: string | null; currency: string }>
  /** What the books are kept in, so the extra field appears only when it matters. */
  homeCurrency: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [kind, setKind] = useState<'payroll' | 'sales_tax'>('payroll')
  const [agency, setAgency] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [paidOn, setPaidOn] = useState('')
  const [amount, setAmount] = useState('')
  const [liabilityAccountId, setLiabilityAccountId] = useState(
    accountsFor('payroll', positions)[0]?.accountId ?? '',
  )
  const [financialAccountId, setFinancialAccountId] = useState(banks[0]?.id ?? '')
  const [reference, setReference] = useState('')
  const [bankPaid, setBankPaid] = useState('')

  // Only the accounts this kind of remittance can clear. The service refuses a
  // mismatch outright — a payroll remittance against Sales Tax Payable balances
  // and leaves both accounts wrong — so the list never offers one.
  const choices = accountsFor(kind, positions)
  const selected = choices.find((entry) => entry.accountId === liabilityAccountId)

  /**
   * The field ADR 0136 said had to come before the wiring (Phase 153).
   *
   * Shown only for an account that is not held in the company's own money,
   * because that is the only case where the two figures differ. A field on every
   * remittance would be a field ignored on every remittance, and the amount it
   * asks for is not a detail — it is what the bank statement will say.
   */
  const bank = banks.find((entry) => entry.id === financialAccountId)
  const foreign = bank !== undefined && bank.currency !== homeCurrency

  function changeKind(next: 'payroll' | 'sales_tax') {
    setKind(next)
    setLiabilityAccountId(accountsFor(next, positions)[0]?.accountId ?? '')
  }

  function submit() {
    let amountCents = 0
    try {
      amountCents = parseAmountToCents(amount)
    } catch (error) {
      setMessage({ text: messageFor(error, 'Bad amount.'), ok: false })
      return
    }

    let bankFaceCents: number | undefined
    if (foreign) {
      try {
        bankFaceCents = parseAmountToCents(bankPaid)
      } catch (error) {
        setMessage({
          text: messageFor(error, `Say what left the account, in ${bank?.currency}.`),
          ok: false,
        })
        return
      }
    }

    startTransition(async () => {
      const result = await recordRemittanceAction({
        kind,
        agency,
        periodStart,
        periodEnd,
        paidOn,
        amountCents,
        liabilityAccountId,
        financialAccountId,
        reference,
        bankFaceCents,
        bankCurrency: foreign ? bank?.currency : undefined,
      })

      setMessage({
        text: result.ok ? (result.message ?? 'Recorded.') : result.error,
        ok: result.ok,
      })

      if (result.ok) {
        setAmount('')
        setReference('')
        setBankPaid('')
        router.refresh()
      }
    })
  }

  if (positions.length === 0 || banks.length === 0) return null

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Record a remittance</h2>
        <p className="text-xs text-muted">
          Posts <span className="font-medium">Dr</span> the liability,{' '}
          <span className="font-medium">Cr</span> the bank. No expense on either side.
        </p>
      </header>

      <div className="space-y-3 p-4">
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-muted">
            Kind
            <select
              className="field mt-1"
              value={kind}
              onChange={(event) => changeKind(event.target.value as 'payroll' | 'sales_tax')}
            >
              <option value="payroll">Payroll</option>
              <option value="sales_tax">Sales tax</option>
            </select>
          </label>
          <label className="text-xs text-muted sm:col-span-2">
            Agency
            <input
              className="field mt-1"
              placeholder="Who it was paid to"
              value={agency}
              onChange={(event) => setAgency(event.target.value)}
            />
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
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
            Paid on
            <input
              className="field mt-1"
              type="date"
              value={paidOn}
              onChange={(event) => setPaidOn(event.target.value)}
            />
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-muted">
            Liability cleared
            <select
              className="field mt-1"
              value={liabilityAccountId}
              onChange={(event) => setLiabilityAccountId(event.target.value)}
            >
              {choices.map((entry) => (
                <option key={entry.accountId} value={entry.accountId}>
                  {entry.accountNumber} {entry.accountName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Paid from
            <select
              className="field mt-1"
              value={financialAccountId}
              onChange={(event) => setFinancialAccountId(event.target.value)}
            >
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                  {bank.mask ? ` ••${bank.mask}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Amount{foreign ? ` off the liability (${homeCurrency})` : ''}
            <input
              className="field mt-1 text-right"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          {foreign && (
            <label className="text-xs text-muted">
              Paid from the account ({bank?.currency})
              <input
                className="field mt-1 text-right"
                placeholder="0.00"
                value={bankPaid}
                onChange={(event) => setBankPaid(event.target.value)}
              />
            </label>
          )}
        </div>
        {foreign && (
          <p className="px-4 pb-1 text-xs text-muted">
            {bank?.name} is held in {bank?.currency} and these books are kept in {homeCurrency}. The
            liability comes off at what the ledger says is owed; the account gives up what you
            actually paid, at the rate on the day. Any difference between the two is posted as a
            realised exchange gain or loss rather than quietly left out of the bank balance.
          </p>
        )}

        {selected && (
          <p className="text-xs text-faint">
            The ledger says {formatCents(selected.balanceCents)} is owed on {selected.accountNumber}{' '}
            {selected.accountName}.{' '}
            {selected.balanceCents > 0 && (
              <button
                type="button"
                className="underline"
                onClick={() => setAmount((selected.balanceCents / 100).toFixed(2))}
              >
                Use that amount
              </button>
            )}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field w-56"
            placeholder="Reference (optional)"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <button className="btn btn-primary text-xs" disabled={pending} onClick={submit}>
            {pending ? 'Recording…' : 'Record remittance'}
          </button>
        </div>

        {message && (
          <p className={`text-xs ${message.ok ? 'text-positive' : 'text-negative'}`} role="status">
            {message.text}
          </p>
        )}
      </div>
    </section>
  )
}

/** The liability accounts a given kind of remittance is allowed to clear. */
function accountsFor(kind: 'payroll' | 'sales_tax', positions: Position[]): Position[] {
  const numbers = kind === 'sales_tax' ? ['2200'] : ['2300', '2350']
  return positions.filter((entry) => numbers.includes(entry.accountNumber))
}
