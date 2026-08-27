'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createBillAction,
  createCustomerAction,
  createInvoiceAction,
  createVendorAction,
  recordPaymentAction,
  voidDocumentAction,
  type ActionResult,
} from '@/app/actions/documents'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Party = { id: string; name: string }
type Account = { id: string; label: string }

type Document = {
  id: string
  number: string
  partyName: string
  issueDate: string
  dueDate: string
  status: string
  totalCents: number
  balanceCents: number
}

type Owed = { id: string; name: string; outstandingCents: number; documentCount: number }

type Line = { description: string; quantity: string; unitPrice: string; chartAccountId: string }

const BLANK_LINE: Line = { description: '', quantity: '', unitPrice: '', chartAccountId: '' }

type Side = 'customer' | 'vendor'

/**
 * Raising an invoice, entering a bill, recording a payment.
 *
 * Both sides on one screen, because they are the same operation in opposite
 * directions and a business does both in the same ten minutes. The running
 * total is shown while the lines are typed — an invoice whose figure somebody
 * only discovers after posting is one they have to void.
 */
export function InvoicesBoard({
  invoices,
  bills,
  customers,
  vendors,
  revenueAccounts,
  costAccounts,
  owedByCustomers,
  owedToVendors,
  banks,
  today,
  canManage,
  canAddCustomer,
}: {
  invoices: Document[]
  bills: Document[]
  customers: Party[]
  vendors: Party[]
  revenueAccounts: Account[]
  costAccounts: Account[]
  owedByCustomers: Owed[]
  owedToVendors: Owed[]
  banks: Party[]
  today: string
  canManage: boolean
  canAddCustomer: boolean
}) {
  const router = useRouter()
  const [side, setSide] = useState<Side>('customer')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  function act(fn: () => Promise<ActionResult<unknown>>, onOk?: () => void) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) {
        onOk?.()
        router.refresh()
      }
    })
  }

  const isCustomer = side === 'customer'
  const documents = isCustomer ? invoices : bills
  const parties = isCustomer ? customers : vendors
  const accounts = isCustomer ? revenueAccounts : costAccounts
  const owed = isCustomer ? owedByCustomers : owedToVendors

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Invoices &amp; bills</h2>
        <p className="text-sm text-muted">
          What customers owe you, and what you owe suppliers.{' '}
          <span className="text-faint">
            Raising one posts it to the ledger and puts it on the aging report in the same
            breath — there is no separate step, and nothing is owed twice.
          </span>
        </p>
      </header>

      <div className="flex flex-wrap gap-1">
        <button
          onClick={() => setSide('customer')}
          className={`chip px-3 py-1.5 text-sm ${
            isCustomer ? 'bg-brand text-brand-ink' : 'bg-raised text-muted hover:text-ink'
          }`}
        >
          Customers owe us
        </button>
        <button
          onClick={() => setSide('vendor')}
          className={`chip px-3 py-1.5 text-sm ${
            !isCustomer ? 'bg-brand text-brand-ink' : 'bg-raised text-muted hover:text-ink'
          }`}
        >
          We owe suppliers
        </button>
      </div>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          <p className="whitespace-pre-line">{notice.text}</p>
        </div>
      )}

      {canManage && (
        <>
          <Composer
            key={side}
            side={side}
            parties={parties}
            accounts={accounts}
            today={today}
            pending={pending}
            canAddParty={isCustomer ? canAddCustomer : true}
            act={act}
          />
          <PaymentPanel
            key={`pay-${side}`}
            side={side}
            owed={owed}
            banks={banks}
            today={today}
            pending={pending}
            act={act}
          />
        </>
      )}

      <DocumentList
        side={side}
        documents={documents}
        canManage={canManage}
        pending={pending}
        act={act}
      />
    </div>
  )
}

function Composer({
  side,
  parties,
  accounts,
  today,
  pending,
  canAddParty,
  act,
}: {
  side: Side
  parties: Party[]
  accounts: Account[]
  today: string
  pending: boolean
  canAddParty: boolean
  act: (fn: () => Promise<ActionResult<unknown>>, onOk?: () => void) => void
}) {
  const isCustomer = side === 'customer'
  const [open, setOpen] = useState(false)
  const [chosenPartyId, setPartyId] = useState('')
  const [issueDate, setIssueDate] = useState(today)
  const [dueDate, setDueDate] = useState('')
  const [number, setNumber] = useState('')
  const [memo, setMemo] = useState('')
  const [tax, setTax] = useState('')
  // Deliberately no default account. Coding a sale to whichever revenue
  // account happens to be first is a quiet mistake that surfaces a quarter
  // later on a profit and loss nobody can explain.
  const [lines, setLines] = useState<Line[]>([{ ...BLANK_LINE }])
  const [newParty, setNewParty] = useState('')

  /**
   * The chosen party, or the first one there is.
   *
   * Derived rather than held, because adding the first customer from inside
   * this form changes `parties` underneath it: held state stayed at `''` while
   * the select happily displayed the new customer, so the form looked complete
   * and refused to submit.
   */
  const partyId = parties.some((party) => party.id === chosenPartyId)
    ? chosenPartyId
    : (parties[0]?.id ?? '')

  // Worked out as it is typed. An invoice whose total somebody only discovers
  // after posting is one they have to void and raise again.
  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => {
      const unit = parseAmountToCents(line.unitPrice || '0') ?? 0
      const quantityMilli = line.quantity.trim() ? Math.round(Number(line.quantity) * 1000) : 1000
      if (!Number.isFinite(quantityMilli)) return sum
      return sum + Math.round((quantityMilli * unit) / 1000)
    }, 0)
    const taxCents = parseAmountToCents(tax || '0') ?? 0
    return { subtotal, taxCents, total: subtotal + taxCents }
  }, [lines, tax])

  const ready =
    partyId !== '' &&
    totals.total > 0 &&
    lines.some((line) => line.description.trim() && line.chartAccountId)

  function reset() {
    setLines([{ ...BLANK_LINE }])
    setNumber('')
    setMemo('')
    setTax('')
    setDueDate('')
    setOpen(false)
  }

  function submit() {
    const payload = {
      partyId,
      issueDate,
      dueDate,
      number,
      memo,
      tax,
      lines: lines
        .filter((line) => line.description.trim() && line.chartAccountId)
        .map((line) => ({
          chartAccountId: line.chartAccountId,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        })),
    }

    act(() => (isCustomer ? createInvoiceAction(payload) : createBillAction(payload)), reset)
  }

  const noun = isCustomer ? 'invoice' : 'bill'
  const partyNoun = isCustomer ? 'customer' : 'supplier'

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">
            {isCustomer ? 'Raise an invoice' : 'Enter a bill'}
          </h3>
          <p className="text-xs text-muted">
            {isCustomer
              ? 'Posts Dr Accounts Receivable, Cr the account each line names.'
              : 'Posts Cr Accounts Payable, Dr the account each line names.'}
          </p>
        </div>
        {!open && (
          <button className="btn btn-primary text-sm" onClick={() => setOpen(true)}>
            {isCustomer ? 'Raise an invoice' : 'Enter a bill'}
          </button>
        )}
      </header>

      {open && (
        <div className="space-y-3 px-4 py-3">
          {parties.length === 0 ? (
            <p className="text-sm text-warning">
              No {partyNoun}s yet — add one below first.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted">
                <span className="mb-1 block">{isCustomer ? 'Customer' : 'Supplier'}</span>
                <select
                  value={partyId}
                  onChange={(event) => setPartyId(event.target.value)}
                  className="field py-1.5 text-sm"
                >
                  {parties.map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-muted">
                <span className="mb-1 block">Dated</span>
                <input
                  type="date"
                  value={issueDate}
                  onChange={(event) => setIssueDate(event.target.value)}
                  className="field py-1.5 text-sm"
                />
              </label>

              <label className="text-xs text-muted">
                <span className="mb-1 block">Due</span>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  className="field py-1.5 text-sm"
                />
                <span className="mt-0.5 block text-faint">Blank uses their terms.</span>
              </label>

              <label className="text-xs text-muted">
                <span className="mb-1 block">
                  {isCustomer ? 'Number' : 'Their reference'}
                </span>
                <input
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  placeholder={isCustomer ? 'Automatic' : 'INV-4471'}
                  className="field w-32 py-1.5 text-sm"
                />
              </label>
            </div>
          )}

          {parties.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="py-1 font-medium">Description</th>
                      <th className="py-1 font-medium">{isCustomer ? 'Income account' : 'Account'}</th>
                      <th className="py-1 text-right font-medium">Qty</th>
                      <th className="py-1 text-right font-medium">Each</th>
                      <th className="py-1 text-right font-medium">Amount</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const unit = parseAmountToCents(line.unitPrice || '0') ?? 0
                      const quantityMilli = line.quantity.trim()
                        ? Math.round(Number(line.quantity) * 1000)
                        : 1000
                      const amount = Number.isFinite(quantityMilli)
                        ? Math.round((quantityMilli * unit) / 1000)
                        : 0

                      return (
                        <tr key={index} className="border-t border-line">
                          <td className="py-1.5 pr-2">
                            <input
                              value={line.description}
                              onChange={(event) =>
                                setLines((rows) =>
                                  rows.map((row, i) =>
                                    i === index ? { ...row, description: event.target.value } : row,
                                  ),
                                )
                              }
                              placeholder="A day on site"
                              className="field w-full py-1 text-sm"
                            />
                          </td>
                          <td className="py-1.5 pr-2">
                            <select
                              value={line.chartAccountId}
                              onChange={(event) =>
                                setLines((rows) =>
                                  rows.map((row, i) =>
                                    i === index
                                      ? { ...row, chartAccountId: event.target.value }
                                      : row,
                                  ),
                                )
                              }
                              className="field w-full py-1 text-sm"
                            >
                              <option value="">Choose…</option>
                              {accounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-1.5 pr-2">
                            <input
                              value={line.quantity}
                              onChange={(event) =>
                                setLines((rows) =>
                                  rows.map((row, i) =>
                                    i === index ? { ...row, quantity: event.target.value } : row,
                                  ),
                                )
                              }
                              placeholder="1"
                              inputMode="decimal"
                              className="field w-16 py-1 text-right text-sm"
                            />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input
                              value={line.unitPrice}
                              onChange={(event) =>
                                setLines((rows) =>
                                  rows.map((row, i) =>
                                    i === index ? { ...row, unitPrice: event.target.value } : row,
                                  ),
                                )
                              }
                              placeholder="0.00"
                              inputMode="decimal"
                              className="field w-24 py-1 text-right text-sm"
                            />
                          </td>
                          <td className="tnum py-1.5 pr-2 text-right">{formatCents(amount)}</td>
                          <td className="py-1.5 text-right">
                            {lines.length > 1 && (
                              <button
                                className="btn btn-ghost text-xs"
                                onClick={() =>
                                  setLines((rows) => rows.filter((_, i) => i !== index))
                                }
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-end justify-between gap-3">
                <button
                  className="btn btn-ghost text-xs"
                  onClick={() =>
                    setLines((rows) => [...rows, { ...BLANK_LINE }])
                  }
                >
                  Add a line
                </button>

                <div className="flex items-end gap-3">
                  <label className="text-xs text-muted">
                    <span className="mb-1 block">Tax</span>
                    <input
                      value={tax}
                      onChange={(event) => setTax(event.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                      className="field w-24 py-1 text-right text-sm"
                    />
                  </label>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-wide text-muted">Total</p>
                    <p className="tnum text-lg font-semibold">{formatCents(totals.total)}</p>
                  </div>
                </div>
              </div>

              <label className="block text-xs text-muted">
                <span className="mb-1 block">Note (optional)</span>
                <input
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  className="field w-full py-1.5 text-sm"
                />
              </label>

              <div className="flex items-center gap-2">
                <button className="btn btn-primary" disabled={pending || !ready} onClick={submit}>
                  {isCustomer ? 'Raise it' : 'Enter it'}
                </button>
                <button className="btn btn-ghost" disabled={pending} onClick={reset}>
                  Cancel
                </button>
                {!ready && (
                  <span className="text-xs text-faint">
                    Needs a {partyNoun}, a description, an account and an amount above zero.
                  </span>
                )}
              </div>
            </>
          )}

          {canAddParty && (
            <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <label className="text-xs text-muted">
                <span className="mb-1 block">…or add a new {partyNoun}</span>
                <input
                  value={newParty}
                  onChange={(event) => setNewParty(event.target.value)}
                  placeholder={isCustomer ? 'Harborview LLC' : 'City Power & Light'}
                  className="field py-1.5 text-sm"
                />
              </label>
              <button
                className="btn btn-ghost text-sm"
                disabled={pending || !newParty.trim()}
                onClick={() =>
                  act(
                    () =>
                      isCustomer
                        ? createCustomerAction({ name: newParty })
                        : createVendorAction({ name: newParty }),
                    () => setNewParty(''),
                  )
                }
              >
                Add {partyNoun}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function PaymentPanel({
  side,
  owed,
  banks,
  today,
  pending,
  act,
}: {
  side: Side
  owed: Owed[]
  banks: Party[]
  today: string
  pending: boolean
  act: (fn: () => Promise<ActionResult<unknown>>, onOk?: () => void) => void
}) {
  const isCustomer = side === 'customer'
  const [partyId, setPartyId] = useState('')
  const [amount, setAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(today)
  const [bankId, setBankId] = useState('')
  const [reference, setReference] = useState('')

  const selected = owed.find((party) => party.id === partyId)

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">
          {isCustomer ? 'Record money received' : 'Record money paid'}
        </h3>
        <p className="text-xs text-muted">
          Applied oldest first unless you say otherwise. A payment for more than is outstanding
          is refused rather than left sitting against nothing.
        </p>
      </header>

      <div className="space-y-3 px-4 py-3">
        {owed.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing outstanding {isCustomer ? 'from anybody' : 'to anybody'} just now.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted">
                <span className="mb-1 block">{isCustomer ? 'From' : 'To'}</span>
                <select
                  value={partyId}
                  onChange={(event) => {
                    setPartyId(event.target.value)
                    const next = owed.find((party) => party.id === event.target.value)
                    // Prefilled with what they owe, which is what a payment
                    // usually is, and still editable for a part payment.
                    setAmount(next ? (next.outstandingCents / 100).toFixed(2) : '')
                  }}
                  className="field py-1.5 text-sm"
                >
                  <option value="">Choose…</option>
                  {owed.map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.name} — {formatCents(party.outstandingCents)} over{' '}
                      {party.documentCount}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-muted">
                <span className="mb-1 block">Amount</span>
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="field w-28 py-1.5 text-right text-sm"
                />
              </label>

              <label className="text-xs text-muted">
                <span className="mb-1 block">On</span>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                  className="field py-1.5 text-sm"
                />
              </label>

              <label className="text-xs text-muted">
                <span className="mb-1 block">{isCustomer ? 'Into' : 'Out of'}</span>
                <select
                  value={bankId}
                  onChange={(event) => setBankId(event.target.value)}
                  className="field py-1.5 text-sm"
                >
                  {isCustomer && <option value="">Undeposited funds</option>}
                  {!isCustomer && <option value="">Choose an account…</option>}
                  {banks.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-muted">
                <span className="mb-1 block">Reference</span>
                <input
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="Cheque 1041"
                  className="field w-32 py-1.5 text-sm"
                />
              </label>
            </div>

            {selected && (
              <p className="text-xs text-faint">
                {selected.name} has {formatCents(selected.outstandingCents)} outstanding across{' '}
                {selected.documentCount} {selected.documentCount === 1 ? 'document' : 'documents'}.
                {isCustomer && !bankId && ' Held in Undeposited Funds until you bank it.'}
              </p>
            )}

            <button
              className="btn btn-primary"
              disabled={pending || !partyId || !amount.trim() || (!isCustomer && !bankId)}
              onClick={() =>
                act(
                  () =>
                    recordPaymentAction({
                      kind: isCustomer ? 'receipt' : 'disbursement',
                      partyId,
                      paymentDate,
                      amount,
                      financialAccountId: bankId,
                      reference,
                    }),
                  () => {
                    setPartyId('')
                    setAmount('')
                    setReference('')
                  },
                )
              }
            >
              Record it
            </button>
          </>
        )}
      </div>
    </section>
  )
}

function DocumentList({
  side,
  documents,
  canManage,
  pending,
  act,
}: {
  side: Side
  documents: Document[]
  canManage: boolean
  pending: boolean
  act: (fn: () => Promise<ActionResult<unknown>>, onOk?: () => void) => void
}) {
  const isCustomer = side === 'customer'

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{isCustomer ? 'Invoices' : 'Bills'}</h3>
      </header>

      {documents.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          {isCustomer
            ? 'No invoices yet. Raise one above and it lands on the ledger and the aging report.'
            : 'No bills yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">{isCustomer ? 'Customer' : 'Supplier'}</th>
                <th className="px-4 py-2 font-medium">Dated</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Outstanding</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id} className="border-t border-line">
                  <td className="px-4 py-1.5 font-medium">{document.number}</td>
                  <td className="px-4 py-1.5">{document.partyName}</td>
                  <td className="px-4 py-1.5 text-muted">{document.issueDate}</td>
                  <td className="px-4 py-1.5 text-muted">{document.dueDate}</td>
                  <td className="px-4 py-1.5 text-muted">{document.status.replace('_', ' ')}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(document.totalCents)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {document.balanceCents === 0 ? (
                      <span className="text-success">settled</span>
                    ) : (
                      formatCents(document.balanceCents)
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {canManage &&
                      document.status !== 'void' &&
                      document.balanceCents === document.totalCents && (
                        <button
                          className="btn btn-ghost text-xs text-danger"
                          disabled={pending}
                          onClick={() =>
                            act(() =>
                              voidDocumentAction({
                                kind: isCustomer ? 'invoice' : 'bill',
                                id: document.id,
                              }),
                            )
                          }
                        >
                          Void
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
