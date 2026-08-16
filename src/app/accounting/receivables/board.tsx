'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  applyCreditAction,
  createCreditNoteAction,
  createVendorCreditAction,
  recoverWriteOffAction,
  saveStatementAction,
  writeOffInvoiceAction,
} from '@/app/actions/accounting-core'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Credit = {
  id: string
  number: string
  issueDate: string
  // Nullable on the table since Phase 12, because a vendor credit shares it
  // and carries a vendor instead. Every row this list shows is a customer
  // credit, so it is never null in practice.
  customerId: string | null
  customerName: string
  status: string
  totalCents: number
  remainingCents: number
  reason: string | null
}

type WriteOff = {
  id: string
  invoiceNumber: string
  customerName: string
  writtenOffOn: string
  amountCents: number
  reason: string
  recoveredOn: string | null
  recoveredCents: number | null
}

type CustomerRow = {
  id: string
  name: string
  email: string | null
  balanceCents: number
  openCount: number
}

type StatementRow = {
  id: string
  customerName: string
  kind: string
  asOfDate: string
  closingBalanceCents: number
  sentTo: string | null
}

type OpenInvoice = {
  id: string
  number: string
  customerId: string
  customerName: string
  balanceCents: number
  dueDate: string
}

type VendorCredit = {
  id: string
  number: string
  issueDate: string
  vendorId: string | null
  vendorName: string
  status: string
  totalCents: number
  remainingCents: number
  reason: string | null
}

type OpenBill = {
  id: string
  number: string
  vendorId: string
  vendorName: string
  balanceCents: number
  dueDate: string
}

/**
 * Credits, write-offs, and statements.
 *
 * The two ways a receivable goes away without money arriving are presented
 * next to each other with the difference stated, because that choice is made
 * once and quickly, usually by somebody who has not thought about which is
 * which. Software that offers only "write off" turns every returned order
 * into bad debt.
 */
export function ReceivablesBoard({
  badDebt,
  credits,
  writeOffs,
  customers,
  statements,
  openInvoices,
  banks,
  vendorCredits,
  vendors,
  openBills,
  canManage,
}: {
  badDebt: { count: number; writtenOffCents: number; recoveredCents: number; netCents: number }
  credits: Credit[]
  writeOffs: WriteOff[]
  customers: CustomerRow[]
  statements: StatementRow[]
  openInvoices: OpenInvoice[]
  banks: Array<{ id: string; name: string }>
  vendorCredits: VendorCredit[]
  vendors: Array<{ id: string; name: string }>
  openBills: OpenBill[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [action, setAction] = useState<'credit' | 'write_off' | null>(null)
  const [invoiceId, setInvoiceId] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')

  const [statementCustomer, setStatementCustomer] = useState('')
  const [statementKind, setStatementKind] = useState<'open_item' | 'balance_forward'>('open_item')
  const [statementFrom, setStatementFrom] = useState('')
  const [statementAsOf, setStatementAsOf] = useState(new Date().toISOString().slice(0, 10))

  const [vendorBillId, setVendorBillId] = useState('')
  const [vendorCreditDate, setVendorCreditDate] = useState(new Date().toISOString().slice(0, 10))
  const [vendorReason, setVendorReason] = useState('')

  const [recovering, setRecovering] = useState<string | null>(null)
  const [recoveryAmount, setRecoveryAmount] = useState('')
  const [recoveryBank, setRecoveryBank] = useState(banks[0]?.id ?? '')

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
        ok: result.ok,
      })
      if (result.ok) {
        setAction(null)
        setInvoiceId('')
        setReason('')
        setRecovering(null)
        router.refresh()
      }
    })
  }

  const selected = openInvoices.find((invoice) => invoice.id === invoiceId)

  return (
    <div className="space-y-4">
      {message && (
        <p className={`card p-3 text-sm ${message.ok ? 'text-positive' : 'text-negative'}`} role="status">
          {message.text}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Written off this year" value={formatCents(badDebt.writtenOffCents)} tone={badDebt.writtenOffCents > 0 ? 'bad' : undefined} />
        <Stat label="Recovered" value={formatCents(badDebt.recoveredCents)} />
        <Stat label="Net bad debt" value={formatCents(badDebt.netCents)} />
        <Stat
          label="Credit available"
          value={formatCents(credits.reduce((sum, note) => sum + note.remainingCents, 0))}
          hint="issued and not yet applied"
        />
      </div>

      {/* The choice, with its consequence stated. */}
      {canManage && (
        <section className="card overflow-hidden">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Reduce what a customer owes</h2>
            <p className="text-xs text-muted">
              Two different things that look alike. Getting it wrong hides a collections problem:
              a company that writes bad debt off as a credit note shows lower revenue, no bad debt,
              and an unchanged margin.
            </p>
          </header>

          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <button
              className={`rounded-lg border p-3 text-left transition ${
                action === 'credit' ? 'border-brand bg-raised' : 'border-line hover:bg-raised'
              }`}
              onClick={() => setAction(action === 'credit' ? null : 'credit')}
            >
              <p className="text-sm font-medium">Credit note</p>
              <p className="mt-0.5 text-xs text-muted">
                They owe less — a return, a billing error, a goodwill gesture.
              </p>
              <p className="mt-1 text-xs text-faint">
                <span className="tnum">Dr</span> Revenue · <span className="tnum">Cr</span> Receivable.
                Revenue goes down, because it was never earned.
              </p>
            </button>

            <button
              className={`rounded-lg border p-3 text-left transition ${
                action === 'write_off' ? 'border-brand bg-raised' : 'border-line hover:bg-raised'
              }`}
              onClick={() => setAction(action === 'write_off' ? null : 'write_off')}
            >
              <p className="text-sm font-medium">Write off</p>
              <p className="mt-0.5 text-xs text-muted">
                They owe it and will not pay — insolvency, or gone quiet for a year.
              </p>
              <p className="mt-1 text-xs text-faint">
                <span className="tnum">Dr</span> Bad Debt · <span className="tnum">Cr</span> Receivable.
                Revenue stays; the loss is an expense.
              </p>
            </button>
          </div>

          {action && (
            <div className="space-y-2 border-t border-line p-4">
              <div className="flex flex-wrap gap-2">
                <select
                  className="field flex-1 min-w-64"
                  value={invoiceId}
                  onChange={(event) => setInvoiceId(event.target.value)}
                >
                  <option value="">Choose an invoice…</option>
                  {openInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.number} — {invoice.customerName} — {formatCents(invoice.balanceCents)}
                    </option>
                  ))}
                </select>
                <input
                  className="field w-40"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
                {invoiceId && (
                  <a
                    href={`/api/pdf/invoice/${invoiceId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn text-xs"
                  >
                    Invoice PDF
                  </a>
                )}
              </div>

              <input
                className="field"
                placeholder={
                  action === 'credit'
                    ? 'Why are they being credited?'
                    : 'Why will this not be collected? (required)'
                }
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />

              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="btn btn-primary text-xs"
                  disabled={pending || !invoiceId || (action === 'write_off' && !reason.trim())}
                  onClick={() =>
                    act(() =>
                      action === 'credit'
                        ? createCreditNoteAction({
                            customerId: selected!.customerId,
                            invoiceId,
                            issueDate: date,
                            reason: reason || undefined,
                            applyImmediately: true,
                          })
                        : writeOffInvoiceAction({
                            invoiceId,
                            writtenOffOn: date,
                            reason,
                          }),
                    )
                  }
                >
                  {pending
                    ? 'Working…'
                    : action === 'credit'
                      ? 'Issue the credit note'
                      : 'Write it off'}
                </button>

                {selected && (
                  <p className="text-xs text-faint">
                    {formatCents(selected.balanceCents)} outstanding on {selected.number}.
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Credit notes" subtitle="Revenue reversed on the accounts it was booked to.">
          {credits.length === 0 ? (
            <Empty>None issued.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {credits.map((note) => (
                <li key={note.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {note.number} — {note.customerName}
                      </p>
                      <p className="text-xs text-muted">
                        {note.issueDate}
                        {note.reason ? ` · ${note.reason}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tnum text-sm">{formatCents(note.totalCents)}</p>
                      {note.remainingCents > 0 && (
                        <p className="text-xs text-warning">
                          {formatCents(note.remainingCents)} unapplied
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Written off"
          subtitle="Earned, then lost. The revenue stays on the P&L and the loss sits in Bad Debt."
        >
          {writeOffs.length === 0 ? (
            <Empty>Nothing written off.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {writeOffs.map((row) => (
                <li key={row.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {row.invoiceNumber} — {row.customerName}
                      </p>
                      <p className="text-xs text-muted">
                        {row.writtenOffOn} · {row.reason}
                      </p>
                      {row.recoveredOn && (
                        <p className="text-xs text-positive">
                          Recovered {formatCents(row.recoveredCents ?? 0)} on {row.recoveredOn}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-start gap-2">
                      <span className="tnum text-sm">{formatCents(row.amountCents)}</span>
                      {canManage && !row.recoveredOn && banks.length > 0 && (
                        <button
                          className="btn px-2 py-1 text-xs"
                          onClick={() => {
                            setRecovering(recovering === row.id ? null : row.id)
                            setRecoveryAmount((row.amountCents / 100).toFixed(2))
                          }}
                        >
                          They paid
                        </button>
                      )}
                    </div>
                  </div>

                  {recovering === row.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        className="field w-28 text-right"
                        value={recoveryAmount}
                        onChange={(event) => setRecoveryAmount(event.target.value)}
                      />
                      <select
                        className="field w-44"
                        value={recoveryBank}
                        onChange={(event) => setRecoveryBank(event.target.value)}
                      >
                        {banks.map((bank) => (
                          <option key={bank.id} value={bank.id}>
                            {bank.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-primary px-2 py-1 text-xs"
                        disabled={pending}
                        onClick={() => {
                          let amountCents = 0
                          try {
                            amountCents = parseAmountToCents(recoveryAmount)
                          } catch {
                            setMessage({ text: 'That is not a valid amount.', ok: false })
                            return
                          }
                          act(() =>
                            recoverWriteOffAction({
                              writeOffId: row.id,
                              recoveredOn: new Date().toISOString().slice(0, 10),
                              amountCents,
                              financialAccountId: recoveryBank,
                            }),
                          )
                        }}
                      >
                        Record it
                      </button>
                      <p className="w-full text-xs text-faint">
                        Reverses the bad-debt expense. Not new revenue — that was recognized when
                        the invoice was raised.
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Statements"
        subtitle="Open-item lists what is unpaid; balance-forward carries a total in and out. Saved statements keep the figures as sent."
      >
        {canManage && (
          <div className="flex flex-wrap items-end gap-2 border-b border-line p-4">
            <select
              className="field w-56"
              value={statementCustomer}
              onChange={(event) => setStatementCustomer(event.target.value)}
            >
              <option value="">Choose a customer…</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                  {customer.balanceCents > 0 ? ` — ${formatCents(customer.balanceCents)}` : ''}
                </option>
              ))}
            </select>

            <select
              className="field w-44"
              value={statementKind}
              onChange={(event) =>
                setStatementKind(event.target.value as 'open_item' | 'balance_forward')
              }
            >
              <option value="open_item">Open item</option>
              <option value="balance_forward">Balance forward</option>
            </select>

            {statementKind === 'balance_forward' && (
              <label className="text-xs text-muted">
                From
                <input
                  className="field mt-1 w-36"
                  type="date"
                  value={statementFrom}
                  onChange={(event) => setStatementFrom(event.target.value)}
                />
              </label>
            )}

            <label className="text-xs text-muted">
              As of
              <input
                className="field mt-1 w-36"
                type="date"
                value={statementAsOf}
                onChange={(event) => setStatementAsOf(event.target.value)}
              />
            </label>

            <button
              className="btn btn-primary text-xs"
              disabled={
                pending ||
                !statementCustomer ||
                (statementKind === 'balance_forward' && !statementFrom)
              }
              onClick={() =>
                act(() =>
                  saveStatementAction({
                    customerId: statementCustomer,
                    asOfDate: statementAsOf,
                    kind: statementKind,
                    periodStart: statementKind === 'balance_forward' ? statementFrom : undefined,
                  }),
                )
              }
            >
              Save statement
            </button>
          </div>
        )}

        {statements.length === 0 ? (
          <Empty>No statements saved.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">As of</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                <th className="px-4 py-2 font-medium">To</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-1.5 font-medium">{row.customerName}</td>
                  <td className="px-4 py-1.5 text-muted">{row.kind.replace('_', ' ')}</td>
                  <td className="px-4 py-1.5 text-muted">{row.asOfDate}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(row.closingBalanceCents)}
                  </td>
                  <td className="px-4 py-1.5 text-faint">{row.sentTo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Vendor credits"
        subtitle="The mirror: the supplier agreed you owe less, so the cost comes back off the account the bill was booked to."
      >
        {canManage && (
          <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Against bill</span>
              <select
                value={vendorBillId}
                onChange={(event) => setVendorBillId(event.target.value)}
                className="field py-1.5 text-sm"
              >
                <option value="">Choose a bill…</option>
                {openBills.map((bill) => (
                  <option key={bill.id} value={bill.id}>
                    {bill.number} — {bill.vendorName} ({formatCents(bill.balanceCents)})
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Date</span>
              <input
                type="date"
                value={vendorCreditDate}
                onChange={(event) => setVendorCreditDate(event.target.value)}
                className="field py-1.5 text-sm"
              />
            </label>

            <label className="grow text-xs text-muted">
              <span className="mb-1 block">Reason</span>
              <input
                value={vendorReason}
                onChange={(event) => setVendorReason(event.target.value)}
                placeholder="Damaged in transit, short delivery…"
                className="field w-full py-1.5 text-sm"
              />
            </label>

            <button
              className="btn btn-primary"
              disabled={pending || !vendorBillId}
              onClick={() => {
                const bill = openBills.find((row) => row.id === vendorBillId)
                if (!bill) return
                act(() =>
                  createVendorCreditAction({
                    vendorId: bill.vendorId,
                    billId: bill.id,
                    issueDate: vendorCreditDate,
                    reason: vendorReason.trim() || undefined,
                    applyImmediately: true,
                  }),
                )
              }}
            >
              Issue vendor credit
            </button>
          </div>
        )}

        {vendorCredits.length === 0 ? (
          <Empty>No vendor credits issued.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Vendor</th>
                <th className="px-4 py-2 font-medium">Issued</th>
                <th className="px-4 py-2 font-medium">Reason</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Left</th>
              </tr>
            </thead>
            <tbody>
              {vendorCredits.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-1.5">{row.number}</td>
                  <td className="px-4 py-1.5 font-medium">{row.vendorName}</td>
                  <td className="px-4 py-1.5 text-muted">{row.issueDate}</td>
                  <td className="px-4 py-1.5 text-muted">{row.reason ?? '—'}</td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(row.totalCents)}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(row.remainingCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="border-t border-line px-4 py-3 text-xs text-faint">
          There is no vendor write-off to match the customer one. A debt the supplier stopped
          chasing is a judgement about whether the obligation is really gone, not a bookkeeping
          operation — so it stays a manual journal entry.
        </p>
      </Card>

      {vendors.length === 0 && null}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'bad'
}) {
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${tone === 'bad' ? 'text-negative' : ''}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}
