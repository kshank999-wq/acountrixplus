'use client'

import { Fragment, useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createBillAction,
  createCustomerAction,
  createInvoiceAction,
  createVendorAction,
  quoteDocumentAction,
  recordPaymentAction,
  revokeInvoiceLinkAction,
  sendInvoiceAction,
  shareInvoiceAction,
  voidDocumentAction,
  type ActionResult,
  type Quoted,
} from '@/app/actions/documents'
import { formatCents, parseAmountToCents } from '@/lib/money'
import { CorrectionButton, CorrectionPanel } from '@/components/correction-panel'

type Party = { id: string; name: string }
type Account = { id: string; label: string }

type Document = {
  id: string
  number: string
  partyName: string
  issueDate: string
  dueDate: string
  status: string
  /** What it is owed in — the amounts below are in it (Phase 64). */
  currency: string
  totalCents: number
  balanceCents: number
  /** Invoices only (Phase 42). Bills are received, not sent. */
  sentAt?: string | null
  sentTo?: string | null
  viewCount?: number
  shareToken?: string | null
  /** Bills only (Phase 47). The number printed on the supplier's invoice. */
  vendorReference?: string | null
}

type Owed = { id: string; name: string; outstandingCents: number; documentCount: number }

/** Two bills from one supplier that look like the same invoice (Phase 47). */
type Duplicate = {
  vendorName: string
  keptNumber: string
  keptReference: string | null
  keptIssueDate: string
  suspectNumber: string
  suspectReference: string | null
  suspectIssueDate: string
  totalCents: number
  suspectBalanceCents: number
  why: string
}

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
  duplicates,
  banks,
  homeCurrency,
  currencies,
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
  duplicates: Duplicate[]
  banks: Party[]
  /** The company's own currency — what a document is in unless told otherwise. */
  homeCurrency: string
  /** What may be chosen: home, then every currency with a rate on file. */
  currencies: string[]
  today: string
  canManage: boolean
  canAddCustomer: boolean
}) {
  const router = useRouter()
  const [side, setSide] = useState<Side>('customer')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  /**
   * `onRefused` gets the failure as well as the message (Phase 47).
   *
   * A bill that resembles one already entered is refused with `overridable`
   * set, and the composer has to know that in order to offer "enter it
   * anyway". Passing the whole result rather than a flag keeps the screen from
   * having to read the sentence to work out what happened.
   */
  function act(
    fn: () => Promise<ActionResult<unknown>>,
    onOk?: () => void,
    onRefused?: (result: { error: string; overridable?: true }) => void,
  ) {
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
      } else {
        onRefused?.(result)
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
            homeCurrency={homeCurrency}
            currencies={currencies}
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

      {/* Only on the supplier side, and only when there is something to say.
          The rule at the composer protects a business from today onwards; this
          is the six months already in the books, which is where the bill that
          gets paid twice actually is (Phase 47). */}
      {!isCustomer && duplicates.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-danger">
            Bills that look like the same invoice twice
          </h3>
          <p className="text-sm text-muted">
            Same supplier, same amount, within a fortnight.{' '}
            <span className="text-faint">
              Nothing here is proof — a weekly delivery looks exactly like this. But the same
              invoice entered twice gets paid twice, and getting the second payment back is a
              favour rather than a right, so these are worth a minute each. Void the one that
              should not exist; the other keeps its number.
            </span>
          </p>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Supplier</th>
                  <th className="px-4 py-2">Entered first</th>
                  <th className="px-4 py-2">And again as</th>
                  <th className="px-4 py-2 text-right">Each</th>
                  <th className="px-4 py-2 text-right">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {duplicates.map((pair) => (
                  <tr key={`${pair.keptNumber}-${pair.suspectNumber}`} className="border-t border-line">
                    <td className="px-4 py-2">{pair.vendorName}</td>
                    <td className="px-4 py-2">
                      <span className="font-medium">{pair.keptNumber}</span>
                      <span className="block text-xs text-faint">
                        {pair.keptReference ? `their ${pair.keptReference} · ` : ''}
                        {pair.keptIssueDate}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="font-medium">{pair.suspectNumber}</span>
                      <span className="block text-xs text-faint">
                        {pair.suspectReference ? `their ${pair.suspectReference} · ` : ''}
                        {pair.suspectIssueDate}
                      </span>
                    </td>
                    <td className="tnum px-4 py-2 text-right">{formatCents(pair.totalCents)}</td>
                    <td className="tnum px-4 py-2 text-right">
                      {pair.suspectBalanceCents > 0 ? (
                        <span className="text-danger">
                          {formatCents(pair.suspectBalanceCents)}
                        </span>
                      ) : (
                        <span className="text-faint">paid</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
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
  homeCurrency,
  currencies,
  today,
  pending,
  canAddParty,
  act,
}: {
  side: Side
  parties: Party[]
  accounts: Account[]
  homeCurrency: string
  currencies: string[]
  today: string
  pending: boolean
  canAddParty: boolean
  act: (
    fn: () => Promise<ActionResult<unknown>>,
    onOk?: () => void,
    onRefused?: (result: { error: string; overridable?: true }) => void,
  ) => void
}) {
  const isCustomer = side === 'customer'
  const [open, setOpen] = useState(false)
  const [chosenPartyId, setPartyId] = useState('')
  const [issueDate, setIssueDate] = useState(today)
  const [dueDate, setDueDate] = useState('')
  const [number, setNumber] = useState('')
  const [memo, setMemo] = useState('')
  const [tax, setTax] = useState('')
  /** Home unless somebody says otherwise — what all but a handful of documents are. */
  const [currency, setCurrency] = useState(homeCurrency)
  /**
   * Set when the bill was refused for resembling one already entered
   * (Phase 47). Holding it here rather than reading the notice means the
   * "enter it anyway" button appears for exactly the refusals it may override,
   * and never for a repeated supplier reference, which is not a question.
   */
  const [resemblance, setResemblance] = useState<string | null>(null)
  // Deliberately no default account. Coding a sale to whichever revenue
  // account happens to be first is a quiet mistake that surfaces a quarter
  // later on a profit and loss nobody can explain.
  const [lines, setLines] = useState<Line[]>([{ ...BLANK_LINE }])
  const [newParty, setNewParty] = useState('')
  const [newPartyEmail, setNewPartyEmail] = useState('')
  /** Set when a party of that name is already on the books (Phase 47). */
  const [namesake, setNamesake] = useState<string | null>(null)

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
    // Kept per line as well as summed, because the conversion preview has to
    // convert line by line to match what the posting will do (Phase 64) — a
    // preview built from the total alone would differ by a cent.
    const lineCents = lines.map((line) => {
      const unit = parseAmountToCents(line.unitPrice || '0') ?? 0
      const quantityMilli = line.quantity.trim() ? Math.round(Number(line.quantity) * 1000) : 1000
      if (!Number.isFinite(quantityMilli)) return 0
      return Math.round((quantityMilli * unit) / 1000)
    })
    const subtotal = lineCents.reduce((sum, cents) => sum + cents, 0)
    const taxCents = parseAmountToCents(tax || '0') ?? 0
    return { lineCents, subtotal, taxCents, total: subtotal + taxCents }
  }, [lines, tax])

  /**
   * What this document will book at, or why it cannot be (Phase 64).
   *
   * Asked of the server rather than worked out here, because the rate lives in
   * a table and the arithmetic has to be the posting's own. Only ever asked for
   * a *foreign* document: a domestic one is not a conversion, so there is
   * nothing to say and no reason to make a round trip while somebody types.
   */
  const foreign = currency !== homeCurrency
  const [quote, setQuote] = useState<Quoted>({ note: null, refusal: null })

  // `totals.lineCents` is a new array every render, so depending on it directly
  // would re-ask on every keystroke that changed nothing. The amounts are what
  // the answer depends on, so the amounts are what the effect watches.
  const amountsKey = `${totals.lineCents.join(',')}|${totals.taxCents}`

  useEffect(() => {
    if (!foreign || totals.total <= 0) {
      setQuote({ note: null, refusal: null })
      return
    }

    // Guards against a slow answer for one currency landing after a fast answer
    // for the next and overwriting it — which would show the euro conversion
    // beside a document somebody has since switched to sterling.
    let current = true

    quoteDocumentAction({
      currency,
      issueDate,
      lineCents: totals.lineCents,
      taxCents: totals.taxCents,
    }).then((result) => {
      if (current) setQuote(result)
    })

    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- amountsKey stands
    // in for the line amounts, which are a fresh array on every render.
  }, [currency, foreign, issueDate, amountsKey, totals.total])

  const ready =
    partyId !== '' &&
    totals.total > 0 &&
    lines.some((line) => line.description.trim() && line.chartAccountId) &&
    // A foreign document with no rate cannot be raised, and saying so here
    // rather than letting the button fail is Phase 47's rule.
    quote.refusal === null

  function reset() {
    setLines([{ ...BLANK_LINE }])
    setNumber('')
    setMemo('')
    setTax('')
    setDueDate('')
    setResemblance(null)
    // Back to home rather than staying where the last document was. A composer
    // that silently keeps EUR selected turns one foreign invoice into a habit
    // of raising them by accident.
    setCurrency(homeCurrency)
    setQuote({ note: null, refusal: null })
    setOpen(false)
  }

  function addParty(allowNamesake: boolean) {
    const payload = { name: newParty, email: newPartyEmail, allowNamesake }

    act(
      () => (isCustomer ? createCustomerAction(payload) : createVendorAction(payload)),
      () => {
        setNewParty('')
        setNewPartyEmail('')
        setNamesake(null)
      },
      (result) => setNamesake(result.error),
    )
  }

  function submit(acknowledgeDuplicate = false) {
    const payload = {
      partyId,
      issueDate,
      dueDate,
      // Ours for an invoice, theirs for a bill — two different things, and
      // they shared this field until Phase 47.
      number: isCustomer ? number : '',
      vendorReference: isCustomer ? undefined : number,
      acknowledgeDuplicate,
      currency,
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

    if (isCustomer) {
      act(() => createInvoiceAction(payload), reset)
      return
    }

    act(
      () => createBillAction(payload),
      reset,
      (result) => setResemblance(result.overridable ? result.error : null),
    )
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

              {/* Only where there is a choice. A company that has never
                  recorded a rate has exactly one currency it can post in, and
                  a select offering one option is a question with no answer. */}
              {currencies.length > 1 && (
                <label className="text-xs text-muted">
                  <span className="mb-1 block">In</span>
                  <select
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                    className="field py-1.5 text-sm"
                  >
                    {currencies.map((code) => (
                      <option key={code} value={code}>
                        {code}
                        {code === homeCurrency ? ' — your books' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="text-xs text-muted">
                <span className="mb-1 block">
                  {isCustomer ? 'Number' : "Supplier's invoice number"}
                </span>
                <input
                  value={number}
                  onChange={(event) => {
                    setNumber(event.target.value)
                    // Changing the reference changes the answer, so the
                    // question a person was being asked is no longer the one
                    // this button would be answering.
                    setResemblance(null)
                  }}
                  placeholder={isCustomer ? 'Automatic' : 'INV-4471'}
                  className="field w-40 py-1.5 text-sm"
                />
                {!isCustomer && (
                  <span className="mt-0.5 block text-faint">
                    Theirs, not ours. It is what stops this bill being entered — and paid —
                    twice.
                  </span>
                )}
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
                    <p className="tnum text-lg font-semibold">
                      {formatCents(totals.total, currency)}
                    </p>
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

              {/* What it books at, before it is raised (Phase 64). The rate is
                  fixed at issue and never recomputed, so this is the last
                  moment anybody can question the number. */}
              {quote.note && (
                <p className="rounded-lg border border-line bg-raised/60 px-3 py-2 text-xs text-muted">
                  {quote.note}
                </p>
              )}

              {/* The refusal on the row rather than behind the button
                  (Phase 47). A rate that is not on file is not something the
                  posting can invent, so there is nothing to be gained by
                  letting somebody finish the form and press a button that
                  fails. */}
              {quote.refusal && (
                <div className="rounded-lg border border-danger/40 bg-raised/60 px-3 py-3 text-sm">
                  <p className="font-medium text-danger">
                    No rate to raise this {currency} {isCustomer ? 'invoice' : 'bill'} at.
                  </p>
                  <p className="mt-1 text-muted">{quote.refusal}</p>
                  <a href="/accounting/currencies" className="btn btn-ghost mt-3 text-sm">
                    Enter the rate
                  </a>
                </div>
              )}

              {/* Only ever shown for a *resemblance*. A supplier repeating
                  their own reference is refused outright and this never
                  appears, because there is nothing for a person to decide
                  that the supplier's own numbering has not already said. */}
              {resemblance && (
                <div className="rounded-lg border border-danger/40 bg-raised/60 px-3 py-3 text-sm">
                  <p className="font-medium text-danger">This looks like a bill already entered.</p>
                  <p className="mt-1 text-muted">{resemblance}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      className="btn btn-ghost text-sm"
                      disabled={pending}
                      onClick={() => submit(true)}
                    >
                      It is a different bill — enter it
                    </button>
                    <button className="btn btn-ghost text-sm" disabled={pending} onClick={reset}>
                      Leave it
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  className="btn btn-primary"
                  disabled={pending || !ready}
                  onClick={() => submit()}
                >
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
              <label className="text-xs text-muted">
                {/* Asked for here because without it an invoice can be raised
                    for this customer and never sent to them — the address is
                    the difference between a document and a request for money. */}
                <span className="mb-1 block">
                  Email {isCustomer && <span className="text-faint">(to send invoices)</span>}
                </span>
                <input
                  value={newPartyEmail}
                  onChange={(event) => setNewPartyEmail(event.target.value)}
                  placeholder="ap@harborview.test"
                  type="email"
                  className="field py-1.5 text-sm"
                />
              </label>
              <button
                className="btn btn-ghost text-sm"
                disabled={pending || !newParty.trim()}
                onClick={() => addParty(false)}
              >
                Add {partyNoun}
              </button>
            </div>
          )}

          {/* A second record for one supplier splits their balance and their
              aging in two, and blinds the duplicate-bill rule, which is keyed
              on the vendor. Not a refusal, because two businesses can share a
              name — a question, which the person typing it answers. */}
          {canAddParty && namesake && (
            <div className="rounded-lg border border-danger/40 bg-raised/60 px-3 py-3 text-sm">
              <p className="font-medium text-danger">That name is already here.</p>
              <p className="mt-1 text-muted">{namesake}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-ghost text-sm"
                  disabled={pending}
                  onClick={() => addParty(true)}
                >
                  It is a different business — add it
                </button>
                <button
                  className="btn btn-ghost text-sm"
                  disabled={pending}
                  onClick={() => {
                    setNamesake(null)
                    setNewParty('')
                    setNewPartyEmail('')
                  }}
                >
                  Use the one that is here
                </button>
              </div>
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
  act: (
    fn: () => Promise<ActionResult<unknown>>,
    onOk?: () => void,
    onRefused?: (result: { error: string; overridable?: true }) => void,
  ) => void
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
          Applied oldest first unless you say otherwise.{' '}
          {isCustomer
            ? 'More than is outstanding is banked in full and the difference held as credit for them — never trimmed to fit.'
            : 'More than is outstanding is refused: paying a supplier too much leaves them owing you, which is a vendor credit.'}
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
  act: (
    fn: () => Promise<ActionResult<unknown>>,
    onOk?: () => void,
    onRefused?: (result: { error: string; overridable?: true }) => void,
  ) => void
}) {
  const isCustomer = side === 'customer'

  // Which row has its cancellation panel open. One at a time: two open panels
  // on one table is two half-typed reasons somebody has to keep straight.
  const [cancelling, setCancelling] = useState<string | null>(null)

  /**
   * Nine either way: the two sides each add one column the other does not —
   * a supplier's own reference on bills, and whether it was sent on invoices.
   */
  const COLUMNS = 9

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
                {!isCustomer && <th className="px-4 py-2 font-medium">Their reference</th>}
                <th className="px-4 py-2 font-medium">{isCustomer ? 'Customer' : 'Supplier'}</th>
                <th className="px-4 py-2 font-medium">Dated</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">State</th>
                {isCustomer && <th className="px-4 py-2 font-medium">Sent</th>}
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Outstanding</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <Fragment key={document.id}>
                  <tr className="border-t border-line">
                    <td className="px-4 py-1.5 font-medium">{document.number}</td>
                    {!isCustomer && (
                      <td className="px-4 py-1.5 text-muted">
                        {document.vendorReference ?? <span className="text-faint">—</span>}
                      </td>
                    )}
                    <td className="px-4 py-1.5">{document.partyName}</td>
                    <td className="px-4 py-1.5 text-muted">{document.issueDate}</td>
                    <td className="px-4 py-1.5 text-muted">{document.dueDate}</td>
                    <td className="px-4 py-1.5 text-muted">{document.status.replace('_', ' ')}</td>
                    {isCustomer && (
                      <td className="px-4 py-1.5 text-xs text-muted">
                        {/* Three states, not two. An invoice shared by link has
                            never been emailed and is still out there — saying
                            "not sent" about it hides the fact that somebody can
                            read it, and hid the view count with it. */}
                        {document.sentAt ? (
                          <>
                            {document.sentAt}
                            <span className="block text-faint">{document.sentTo}</span>
                          </>
                        ) : document.shareToken ? (
                          <span className="text-faint">link shared</span>
                        ) : (
                          <span className="text-faint">not sent</span>
                        )}
                        {(document.viewCount ?? 0) > 0 && (
                          <span className="block">
                            opened {document.viewCount}
                            {document.viewCount === 1 ? ' time' : ' times'}
                          </span>
                        )}
                      </td>
                    )}
                    {/* In the document's own currency (Phase 64). The list is
                        where a euro invoice raised above is first seen again,
                        and showing it in dollars would undo the whole point. */}
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatCents(document.totalCents, document.currency)}
                    </td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {document.balanceCents === 0 ? (
                        <span className="text-success">settled</span>
                      ) : (
                        formatCents(document.balanceCents, document.currency)
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-right">
                      {canManage && isCustomer && document.status !== 'void' && (
                        <>
                          <button
                            className="btn btn-ghost text-xs"
                            disabled={pending}
                            onClick={() => act(() => sendInvoiceAction({ invoiceId: document.id }))}
                          >
                            {document.sentAt ? 'Remind' : 'Send'}
                          </button>
                          <button
                            className="btn btn-ghost text-xs"
                            disabled={pending}
                            onClick={() =>
                              act(() =>
                                document.shareToken
                                  ? revokeInvoiceLinkAction({ invoiceId: document.id })
                                  : shareInvoiceAction({ invoiceId: document.id }),
                              )
                            }
                          >
                            {document.shareToken ? 'Revoke link' : 'Get link'}
                          </button>
                        </>
                      )}
                      {canManage &&
                        document.status !== 'void' &&
                        document.balanceCents === document.totalCents && (
                          /* "Cancel the document", not "Void" — the vocabulary
                             owns the word, and it is the one the confirmation
                             and the notice afterwards both use (Phase 70). */
                          <CorrectionButton
                            kind="document.void"
                            open={cancelling === document.id}
                            disabled={pending}
                            onClick={() =>
                              setCancelling((current) =>
                                current === document.id ? null : document.id,
                              )
                            }
                          />
                        )}
                    </td>
                  </tr>

                  {cancelling === document.id && (
                    <tr className="border-t border-line bg-raised/40">
                      <td colSpan={COLUMNS} className="px-4 py-3">
                        <CorrectionPanel
                          kind="document.void"
                          pending={pending}
                          confirmSuffix={document.number}
                          onConfirm={(reason) =>
                            act(
                              () =>
                                voidDocumentAction({
                                  kind: isCustomer ? 'invoice' : 'bill',
                                  id: document.id,
                                  reason,
                                }),
                              () => setCancelling(null),
                            )
                          }
                        >
                          {document.number} comes off the ledger and off the aging report.{' '}
                          {isCustomer
                            ? 'The customer may already be holding it, so what you type here is what explains the gap to them and to whoever reads the books later.'
                            : 'The supplier still thinks it is owed, so say why it is not.'}
                        </CorrectionPanel>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
