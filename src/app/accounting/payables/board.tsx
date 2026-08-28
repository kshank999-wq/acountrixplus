'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { payRunAction, spendVendorCreditAction, type ActionResult } from '@/app/actions/payables'
import { bucketTotals, planRun, type AgeBucket, type PayableBill } from '@/modules/payables/run'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Bill = PayableBill & {
  vendorReference: string | null
  bucket: AgeBucket
  vendorCreditCents: number
}

type Account = {
  id: string
  name: string
  mask: string | null
  /** What it holds. Null for a card, which owes rather than holds. */
  availableCents: number | null
  /** What is owed on it. Null for a bank account. */
  owingCents: number | null
}
type Credit = {
  id: string
  number: string
  vendorId: string
  vendorName: string
  remainingCents: number
}

const BUCKET_LABELS: Record<AgeBucket, string> = {
  overdue: 'Overdue',
  due_now: 'Due today',
  due_soon: 'Due this week',
  later: 'Later',
}

/**
 * What you owe, and choosing what to pay.
 *
 * The selection is the whole point. `recordPaymentAction` has honoured
 * `documentIds` since Phase 41 and nothing ever sent them, so money always
 * landed oldest-first — onto the very bill a business was deliberately holding
 * back while it argued about it.
 */
export function PayablesBoard({
  today,
  bills,
  accounts,
  credits,
  canPay,
}: {
  today: string
  bills: Bill[]
  accounts: Account[]
  credits: Credit[]
  canPay: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const [chosenIds, setChosenIds] = useState<string[]>([])
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [payDate, setPayDate] = useState(today)
  const [reference, setReference] = useState('')

  const [creditId, setCreditId] = useState('')
  const [creditBillId, setCreditBillId] = useState('')
  const [creditAmount, setCreditAmount] = useState('')

  const totals = useMemo(() => bucketTotals(bills, today), [bills, today])
  const owed = bills.reduce((sum, bill) => sum + bill.balanceCents, 0)

  const chosen = bills.filter((bill) => chosenIds.includes(bill.id))
  const account = accounts.find((row) => row.id === accountId) ?? null
  /**
   * No coverage arithmetic for a card (found in the browser).
   *
   * A card's balance is what the business **owes**, and the screen was saying
   * *"Business Credit Card holds $1,404.79 on the ledger. $154.79 left
   * afterwards"* — exactly backwards. Its headroom is its limit less its
   * balance and this system does not know the limit, so it says nothing rather
   * than something wrong.
   */
  const plan = planRun({ chosen, availableCents: account?.availableCents ?? null })

  function act(fn: () => Promise<ActionResult>, onOk?: () => void) {
    startTransition(async () => {
      const result = await fn()
      setNotice(result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error })
      if (result.ok) {
        onOk?.()
        router.refresh()
      }
    })
  }

  function toggle(id: string) {
    setNotice(null)
    setChosenIds((current) =>
      current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
    )
  }

  /** Everything already late. The commonest run a business actually does. */
  function chooseOverdue() {
    setNotice(null)
    setChosenIds(
      bills.filter((bill) => bill.bucket === 'overdue' || bill.bucket === 'due_now').map((b) => b.id),
    )
  }

  const chosenCredit = credits.find((row) => row.id === creditId) ?? null
  // Only this supplier's bills. A credit from one supplier cannot reduce what
  // is owed to another, and offering them would be offering a refusal.
  const creditableBills = chosenCredit
    ? bills.filter((bill) => bill.vendorId === chosenCredit.vendorId)
    : []

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">What we owe</h2>
        <p className="text-sm text-muted">
          Every open bill, soonest due first.{' '}
          <span className="text-faint">
            Tick the ones a payment covers — one payment per supplier, applied to exactly what
            you chose. A bill you are holding back stays untouched.
          </span>
        </p>
      </header>

      {notice && (
        <p
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'border-danger/40 text-danger'}`}
          role="status"
        >
          {notice.text}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        {(['overdue', 'due_now', 'due_soon', 'later'] as const).map((bucket) => (
          <div key={bucket} className="card px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-muted">{BUCKET_LABELS[bucket]}</p>
            <p
              className={`tnum text-xl font-semibold ${
                bucket === 'overdue' && totals[bucket].totalCents > 0 ? 'text-danger' : ''
              }`}
            >
              {formatCents(totals[bucket].totalCents)}
            </p>
            <p className="text-xs text-faint">
              {totals[bucket].count} bill{totals[bucket].count === 1 ? '' : 's'}
            </p>
          </div>
        ))}
      </div>

      {bills.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-muted">
          Nothing is owed. Bills entered under <strong>Invoices &amp; bills</strong> appear here
          the moment they are raised.
        </p>
      ) : (
        <>
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
              <h3 className="text-sm font-semibold">Open bills</h3>
              <p className="text-xs text-muted">
                <span className="tnum">{formatCents(owed)}</span> outstanding in total
              </p>
            </header>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    {canPay && <th className="px-4 py-2" />}
                    <th className="px-4 py-2 font-medium">Bill</th>
                    <th className="px-4 py-2 font-medium">Supplier</th>
                    <th className="px-4 py-2 font-medium">Due</th>
                    <th className="px-4 py-2 font-medium">State</th>
                    <th className="px-4 py-2 text-right font-medium">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => (
                    <tr key={bill.id} className="border-t border-line">
                      {canPay && (
                        <td className="px-4 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Pay ${bill.number}`}
                            checked={chosenIds.includes(bill.id)}
                            onChange={() => toggle(bill.id)}
                          />
                        </td>
                      )}
                      <td className="px-4 py-1.5 font-medium">
                        {bill.number}
                        {bill.vendorReference && (
                          <span className="block text-xs text-faint">
                            their {bill.vendorReference}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-1.5">
                        {bill.vendorName}
                        {/* The same money seen from the other side. Paying in
                            full while holding an unused credit is paying twice
                            for something already sent back. */}
                        {bill.vendorCreditCents > 0 && (
                          <span className="block text-xs text-success">
                            {formatCents(bill.vendorCreditCents)} credit with them
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-muted">{bill.dueDate}</td>
                      <td className="px-4 py-1.5">
                        <span
                          className={
                            bill.bucket === 'overdue'
                              ? 'text-danger'
                              : bill.bucket === 'due_now'
                                ? 'text-ink'
                                : 'text-faint'
                          }
                        >
                          {BUCKET_LABELS[bill.bucket]}
                        </span>
                      </td>
                      <td className="tnum px-4 py-1.5 text-right">
                        {formatCents(bill.balanceCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {canPay && (
              <div className="space-y-3 border-t border-line px-4 py-3">
                {chosen.length === 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-faint">
                      Tick what this payment covers.
                    </p>
                    {totals.overdue.count + totals.due_now.count > 0 && (
                      <button className="btn btn-ghost text-xs" onClick={chooseOverdue}>
                        Everything due or late
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm">
                      <p className="font-medium">
                        {formatCents(plan.totalCents)} across {plan.suppliers.length} payment
                        {plan.suppliers.length === 1 ? '' : 's'}
                      </p>
                      <ul className="mt-1 space-y-0.5 text-xs text-muted">
                        {plan.suppliers.map((supplier) => (
                          <li key={supplier.vendorId}>
                            <strong>{supplier.vendorName}</strong>{' '}
                            <span className="tnum">{formatCents(supplier.totalCents)}</span>
                            <span className="text-faint"> — {supplier.numbers.join(', ')}</span>
                          </li>
                        ))}
                      </ul>
                      {account && account.availableCents !== null && (
                        <p
                          className={`mt-2 text-xs ${plan.covered ? 'text-faint' : 'text-danger'}`}
                        >
                          {account.name} holds {formatCents(account.availableCents)} on the
                          ledger.{' '}
                          {plan.covered
                            ? `${formatCents(plan.remainingCents)} left afterwards.`
                            : plan.warning}
                        </p>
                      )}
                      {account && account.owingCents !== null && (
                        <p className="mt-2 text-xs text-faint">
                          {formatCents(account.owingCents)} is owed on {account.name} already.
                          Paying by card moves the debt rather than settling it, and how much
                          room is left is between the business and its card issuer.
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-end gap-2">
                      <label className="text-xs text-muted">
                        <span className="mb-1 block">Out of</span>
                        <select
                          value={accountId}
                          onChange={(event) => setAccountId(event.target.value)}
                          className="field py-1.5 text-sm"
                        >
                          {accounts.map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.name}
                              {row.mask ? ` ••${row.mask}` : ''} —{' '}
                              {row.availableCents !== null
                                ? formatCents(row.availableCents)
                                : `${formatCents(row.owingCents ?? 0)} owed`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs text-muted">
                        <span className="mb-1 block">On</span>
                        <input
                          type="date"
                          value={payDate}
                          onChange={(event) => setPayDate(event.target.value)}
                          className="field py-1.5 text-sm"
                        />
                      </label>
                      <label className="text-xs text-muted">
                        <span className="mb-1 block">Reference</span>
                        <input
                          value={reference}
                          onChange={(event) => setReference(event.target.value)}
                          placeholder="BACS 28 Aug"
                          className="field w-36 py-1.5 text-sm"
                        />
                      </label>
                      <button
                        className="btn btn-primary text-sm"
                        disabled={pending || !accountId}
                        onClick={() =>
                          act(
                            () =>
                              payRunAction({
                                billIds: chosenIds,
                                financialAccountId: accountId,
                                paymentDate: payDate,
                                reference,
                              }),
                            () => {
                              setChosenIds([])
                              setReference('')
                            },
                          )
                        }
                      >
                        Pay {formatCents(plan.totalCents)}
                      </button>
                      <button
                        className="btn btn-ghost text-sm"
                        disabled={pending}
                        onClick={() => setChosenIds([])}
                      >
                        Clear
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          {/* `applyVendorCredit` and its action have existed since Phase 12 with
              no caller in src/app, so a credit with anything left was stranded
              for ever. The screen showed the balance beside no control. */}
          {canPay && credits.length > 0 && (
            <section className="card px-4 py-4">
              <h3 className="text-sm font-semibold">Credit your suppliers owe you</h3>
              <p className="mt-1 text-sm text-muted">
                Spend it against one of their bills.{' '}
                <span className="text-faint">
                  It settles the bill without money leaving the bank, which is what makes it a
                  credit rather than a discount on the next one.
                </span>
              </p>

              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Credit</span>
                  <select
                    value={creditId}
                    onChange={(event) => {
                      setCreditId(event.target.value)
                      setCreditBillId('')
                      setCreditAmount('')
                    }}
                    className="field py-1.5 text-sm"
                  >
                    <option value="">Choose…</option>
                    {credits.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.number} — {row.vendorName} — {formatCents(row.remainingCents)} left
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs text-muted">
                  <span className="mb-1 block">Against</span>
                  <select
                    value={creditBillId}
                    onChange={(event) => setCreditBillId(event.target.value)}
                    disabled={!chosenCredit}
                    className="field py-1.5 text-sm"
                  >
                    <option value="">
                      {chosenCredit && creditableBills.length === 0
                        ? 'Nothing open with them'
                        : 'Choose…'}
                    </option>
                    {creditableBills.map((bill) => (
                      <option key={bill.id} value={bill.id}>
                        {bill.number} — {formatCents(bill.balanceCents)} outstanding
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs text-muted">
                  <span className="mb-1 block">Amount</span>
                  <input
                    value={creditAmount}
                    onChange={(event) => setCreditAmount(event.target.value)}
                    placeholder="0.00"
                    className="field w-28 py-1.5 text-right text-sm tnum"
                  />
                  <span className="mt-0.5 block text-faint">Blank uses what fits.</span>
                </label>

                <button
                  className="btn btn-ghost text-sm"
                  disabled={pending || !creditId || !creditBillId}
                  onClick={() => {
                    const bill = bills.find((row) => row.id === creditBillId)
                    if (!chosenCredit || !bill) return

                    // What fits: never more than the credit has, never more
                    // than the bill still owes. Both refusals exist in the
                    // service; defaulting sensibly means nobody meets them.
                    const fits = Math.min(chosenCredit.remainingCents, bill.balanceCents)
                    const typed = creditAmount.trim() ? parseAmountToCents(creditAmount) : fits

                    if (typed === null) {
                      setNotice({ ok: false, text: `“${creditAmount}” is not an amount.` })
                      return
                    }

                    act(
                      () =>
                        spendVendorCreditAction({
                          creditNoteId: chosenCredit.id,
                          billId: bill.id,
                          amountCents: typed,
                          appliedOn: payDate,
                        }),
                      () => {
                        setCreditId('')
                        setCreditBillId('')
                        setCreditAmount('')
                      },
                    )
                  }}
                >
                  Apply it
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
