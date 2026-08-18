'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  addPractitionerAction,
  bookAction,
  closeAction,
  completeAction,
  redeemGiftCardAction,
  sellGiftCardAction,
  takePaymentAction,
  type ActionResult,
} from '@/app/actions/appointments'
import { TakePayment } from '@/components/take-payment'

type Row = {
  id: string
  practitionerId: string
  practitionerName: string
  customerName: string | null
  startsAt: string
  endsAt: string
  status: string
  priceCents: number
  productCents: number
  practitionerCents: number | null
  invoiceId: string | null
  outstandingCents: number
}

type Props = {
  rows: Row[]
  summary: {
    booked: number
    completed: number
    noShow: number
    cancelled: number
    deliveredCents: number
    bookedCents: number
    noShowRateBp: number
  }
  practitioners: Array<{
    id: string
    name: string
    commissionBp: number
    productCommissionBp: number
    isActive: boolean
  }>
  payouts: {
    earnedCents: number
    ledgerCents: number
    paidOutCents: number
    agrees: boolean
    perPractitioner: Array<{
      practitionerId: string
      name: string
      earnedCents: number
      appointments: number
    }>
  } | null
  cards: {
    outstandingCents: number
    ledgerCents: number
    differenceCents: number
    agrees: boolean
    cardsIssued: number
    cardsWithBalance: number
    issuedCents: number
  } | null
  today: string
  canManage: boolean
  canAddStaff: boolean
}

const TABS = ['Diary', 'Who is owed', 'Gift cards'] as const
type Tab = (typeof TABS)[number]

function when(iso: string): string {
  const date = new Date(iso)
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`
}

/**
 * The appointments workspace (spec §5, Phase 29).
 *
 * Opens on the diary, because the question somebody opens this to answer is
 * "who is in today and has it been marked done" — and neither a payout report
 * nor a booking form answers that.
 */
export function AppointmentsBoard(props: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('Diary')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showBook, setShowBook] = useState(false)

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Appointments</h2>
        <p className="text-sm text-muted">
          {props.summary.completed} delivered · {formatCents(props.summary.deliveredCents)} earned ·{' '}
          <span className="text-faint">
            {props.summary.booked} still in the diary worth{' '}
            {formatCents(props.summary.bookedCents)}, which is not revenue
          </span>
        </p>

        {props.canManage && (
          <div className="mt-2 flex gap-2">
            <button className="btn btn-ghost text-xs" onClick={() => setShowBook((was) => !was)}>
              {showBook ? 'Never mind' : 'Book somebody in'}
            </button>
          </div>
        )}
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {showBook && props.canManage && (
        <BookForm {...props} act={act} pending={pending} onDone={() => setShowBook(false)} />
      )}

      <nav className="flex gap-1 border-b border-line text-sm">
        {TABS.map((name) => (
          <button
            className={`px-3 py-2 ${
              tab === name ? 'border-b-2 border-brand font-medium' : 'text-muted'
            }`}
            key={name}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </nav>

      {tab === 'Diary' && <Diary {...props} act={act} pending={pending} />}
      {tab === 'Who is owed' && (
        <div className="space-y-4">
          <Payouts {...props} />
          {props.canAddStaff && <PractitionerForm {...props} act={act} pending={pending} />}
        </div>
      )}
      {tab === 'Gift cards' && <Cards {...props} act={act} pending={pending} />}
    </div>
  )
}

type Helpers = { act: (fn: () => Promise<ActionResult>) => void; pending: boolean }

function Diary({ rows, today, canManage, summary, act, pending }: Props & Helpers) {
  return (
    <div className="space-y-4">
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Who</th>
              <th className="px-4 py-2">With</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">Their share</th>
              <th className="px-4 py-2">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={6}>
                  Nothing in the diary yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-2 tabular-nums">{when(row.startsAt)}</td>
                <td className="px-4 py-2">{row.customerName ?? <span className="text-faint">—</span>}</td>
                <td className="px-4 py-2">{row.practitionerName}</td>
                <td className="px-4 py-2 tabular-nums">
                  {formatCents(row.priceCents + row.productCents)}
                  {row.productCents > 0 && (
                    <span className="block text-xs text-faint">
                      incl. {formatCents(row.productCents)} retail
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {row.practitionerCents === null ? (
                    <span className="text-faint">not yet earned</span>
                  ) : (
                    formatCents(row.practitionerCents)
                  )}
                </td>
                <td className="px-4 py-2">
                  <Outcome status={row.status} />
                  {canManage && row.status === 'booked' && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() =>
                            completeAction({ appointmentId: row.id, completedOn: today }),
                          )
                        }
                      >
                        Done
                      </button>
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() => closeAction({ appointmentId: row.id, status: 'no_show' }))
                        }
                      >
                        No-show
                      </button>
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() => closeAction({ appointmentId: row.id, status: 'cancelled' }))
                        }
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {row.status === 'completed' && row.invoiceId && (
                    <span
                      className={`block text-xs ${
                        row.outstandingCents > 0 ? 'text-warning' : 'text-success'
                      }`}
                    >
                      {row.outstandingCents > 0
                        ? `${formatCents(row.outstandingCents)} owing`
                        : 'paid'}
                    </span>
                  )}
                  {canManage && row.status === 'completed' && (
                    <>
                      {row.invoiceId && row.outstandingCents > 0 && (
                        <div className="mt-1">
                          <TakePayment
                            act={act}
                            invoiceId={row.invoiceId}
                            outstandingCents={row.outstandingCents}
                            pending={pending}
                            takePaymentAction={takePaymentAction}
                            today={today}
                          />
                        </div>
                      )}
                      <RedeemAgainst
                        appointmentId={row.id}
                        act={act}
                        pending={pending}
                        today={today}
                      />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-faint">
        A no-show and a cancellation are counted apart on purpose: a cancellation is a slot given
        back in time to sell again, a no-show is one that was lost.{' '}
        {summary.noShow + summary.completed > 0 && (
          <>
            {(summary.noShowRateBp / 100).toFixed(1)}% of the people expected did not come.
          </>
        )}{' '}
        Neither posts anything.
      </p>
    </div>
  )
}

/**
 * Adding somebody who takes appointments.
 *
 * A practitioner is not a user and usually has no login — a chair renter and a
 * visiting physiotherapist earn a share and never sign in — so this is the only
 * way one comes into being, and a salon with none of them cannot book anybody.
 */
function PractitionerForm({ practitioners, act, pending }: Props & Helpers) {
  return (
    <form
      className="card space-y-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        act(() =>
          addPractitionerAction({
            name: String(form.get('name')),
            commissionBp: Math.round(Number(form.get('commission') ?? 0) * 100),
            productCommissionBp: Math.round(Number(form.get('productCommission') ?? 0) * 100),
          }),
        )
        event.currentTarget.reset()
      }}
    >
      <h3 className="text-sm font-semibold">Who takes appointments</h3>
      <p className="text-xs text-muted">
        {practitioners.length === 0
          ? 'Nobody yet — add somebody before booking anyone in.'
          : practitioners.map((row) => row.name).join(', ')}
      </p>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs sm:col-span-2">
          <span className="block text-faint">Name</span>
          <input className="field" name="name" required />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Share of service (%)</span>
          <input className="field" defaultValue={0} max={100} min={0} name="commission" type="number" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Share of retail (%)</span>
          <input
            className="field"
            defaultValue={0}
            max={100}
            min={0}
            name="productCommission"
            type="number"
          />
        </label>
      </div>

      <button className="btn text-sm" disabled={pending} type="submit">
        Add
      </button>
    </form>
  )
}

/**
 * Settling a delivered visit with a card, from the row it belongs to.
 *
 * Inline rather than on the gift-card tab, because the moment somebody produces
 * a card is the moment the visit is being closed out — and a separate screen
 * that asks which appointment they mean is a screen nobody uses.
 */
function RedeemAgainst({
  appointmentId,
  act,
  pending,
  today,
}: Helpers & { appointmentId: string; today: string }) {
  const [code, setCode] = useState('')

  return (
    <form
      className="mt-1 flex gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        act(() => redeemGiftCardAction({ code, appointmentId, redeemedOn: today }))
        setCode('')
      }}
    >
      <input
        className="field w-24 text-xs"
        onChange={(event) => setCode(event.target.value)}
        placeholder="Card code"
        value={code}
      />
      <button className="btn btn-ghost text-xs" disabled={pending || !code} type="submit">
        Redeem
      </button>
    </form>
  )
}

function Outcome({ status }: { status: string }) {
  if (status === 'completed') return <span className="text-success">delivered</span>
  if (status === 'no_show') return <span className="text-danger">no-show</span>
  if (status === 'cancelled') return <span className="text-faint">cancelled</span>
  return <span className="text-warning">booked</span>
}

function Payouts({ payouts }: Props) {
  if (!payouts) {
    return <p className="text-sm text-muted">Your role does not include the payout report.</p>
  }

  return (
    <div className="space-y-4">
      <div className="card px-4 py-3">
        <h3 className="text-sm font-semibold">What practitioners are owed</h3>
        <p className="mt-1 text-xs text-muted">
          Their share is theirs from the moment the work is done, not from the moment payday comes.
          The left is what delivered visits say was earned; the right is what account 2320 still
          holds after payroll has drawn on it. Money leaves that account by a door this workspace
          does not control, which is what makes the comparison worth anything.
        </p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-faint">Earned</dt>
            <dd className="text-lg tabular-nums">{formatCents(payouts.earnedCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Still owed (account 2320)</dt>
            <dd className="text-lg tabular-nums text-warning">
              {formatCents(payouts.ledgerCents)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Paid out</dt>
            <dd className="text-lg tabular-nums">{formatCents(payouts.paidOutCents)}</dd>
          </div>
        </dl>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Practitioner</th>
              <th className="px-4 py-2">Visits</th>
              <th className="px-4 py-2">Earned</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {payouts.perPractitioner.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={3}>
                  Nothing delivered yet.
                </td>
              </tr>
            )}
            {payouts.perPractitioner.map((row) => (
              <tr key={row.practitionerId}>
                <td className="px-4 py-2">{row.name}</td>
                <td className="px-4 py-2 tabular-nums">{row.appointments}</td>
                <td className="px-4 py-2 tabular-nums">{formatCents(row.earnedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Cards({ cards, today, canManage, act, pending }: Props & Helpers) {
  const [code, setCode] = useState('')
  const [amount, setAmount] = useState('')

  return (
    <div className="space-y-4">
      {cards && (
        <div className="card px-4 py-3">
          <h3 className="text-sm font-semibold">Gift cards outstanding</h3>
          <p className="mt-1 text-xs text-muted">
            Money taken for a service not yet given. It is a liability on the day it is sold and
            revenue only when somebody uses the card — so none of{' '}
            {formatCents(cards.issuedCents)} sold has ever touched the profit and loss on its own
            account.
          </p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-faint">On the cards</dt>
              <dd className="text-lg tabular-nums">{formatCents(cards.outstandingCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">On account 2590</dt>
              <dd className="text-lg tabular-nums">{formatCents(cards.ledgerCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Agrees</dt>
              <dd
                className={`text-lg ${cards.agrees ? 'text-success' : 'text-danger'}`}
              >
                {cards.agrees ? 'Yes' : `No — out by ${formatCents(cards.differenceCents)}`}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-faint">
            {cards.cardsIssued} sold, {cards.cardsWithBalance} with something left on them. Unlike
            the payout figures above, these two <strong>should</strong> match exactly: nothing
            legitimately moves 2590 except selling and spending a card, and both do it in the same
            transaction as the balance.
          </p>
        </div>
      )}

      {canManage && (
        <form
          className="card space-y-3 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            act(() =>
              sellGiftCardAction({
                code,
                amountCents: Math.round(Number(amount) * 100),
                issuedOn: today,
              }),
            )
            setCode('')
            setAmount('')
          }}
        >
          <h3 className="text-sm font-semibold">Sell a card</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-xs">
              <span className="block text-faint">Code</span>
              <input
                className="field"
                onChange={(event) => setCode(event.target.value)}
                placeholder="GC-1004"
                required
                value={code}
              />
            </label>
            <label className="text-xs">
              <span className="block text-faint">Amount</span>
              <input
                className="field"
                min="0.01"
                onChange={(event) => setAmount(event.target.value)}
                required
                step="0.01"
                type="number"
                value={amount}
              />
            </label>
            <div className="flex items-end">
              <button className="btn text-sm" disabled={pending} type="submit">
                Sell
              </button>
            </div>
          </div>
          <p className="text-xs text-faint">
            This takes money and earns none of it.
          </p>
        </form>
      )}
    </div>
  )
}

function BookForm({
  practitioners,
  today,
  act,
  pending,
  onDone,
}: Props & Helpers & { onDone: () => void }) {
  return (
    <form
      className="card space-y-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const date = String(form.get('date'))
        const start = String(form.get('start'))
        const minutes = Number(form.get('minutes') ?? 60)

        const startsAt = new Date(`${date}T${start}:00Z`)
        const endsAt = new Date(startsAt.getTime() + minutes * 60_000)

        act(() =>
          bookAction({
            practitionerId: String(form.get('practitionerId')),
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            priceCents: Math.round(Number(form.get('price') ?? 0) * 100) || 0,
            productCents: Math.round(Number(form.get('products') ?? 0) * 100) || 0,
            notes: String(form.get('notes') ?? ''),
          }),
        )
        onDone()
      }}
    >
      <h3 className="text-sm font-semibold">Book somebody in</h3>
      <p className="text-xs text-muted">
        The diary refuses to put one practitioner in two places at once, and it is the database that
        refuses it rather than a check that could lose a race with the online booking form.
      </p>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs sm:col-span-2">
          <span className="block text-faint">With</span>
          <select className="field" name="practitionerId" required>
            {practitioners
              .filter((row) => row.isActive)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} ({(row.commissionBp / 100).toFixed(0)}%)
                </option>
              ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="block text-faint">Day</span>
          <input className="field" defaultValue={today} name="date" required type="date" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Start</span>
          <input className="field" defaultValue="10:00" name="start" required type="time" />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="block text-faint">Minutes</span>
          <input className="field" defaultValue={60} min={5} name="minutes" step={5} type="number" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Service price</span>
          <input className="field" min="0" name="price" step="0.01" type="number" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Retail</span>
          <input className="field" min="0" name="products" step="0.01" type="number" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Note</span>
          <input className="field" name="notes" />
        </label>
      </div>

      <button className="btn text-sm" disabled={pending} type="submit">
        Book
      </button>
    </form>
  )
}
