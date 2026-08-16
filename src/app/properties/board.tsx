'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  applyDepositAction,
  createLeaseAction,
  createPropertyAction,
  createUnitAction,
  endLeaseAction,
  receiveDepositAction,
  refundDepositAction,
  runRentAction,
  type ActionResult,
} from '@/app/actions/properties'

type Named = { id: string; name: string }

type RollRow = {
  unitId: string
  propertyId: string
  propertyCode: string
  propertyName: string
  unitCode: string
  unitName: string | null
  status: 'available' | 'occupied' | 'unavailable'
  marketRentCents: number
  leaseId: string | null
  tenantName: string | null
  contractedRentCents: number | null
  startsOn: string | null
  endsOn: string | null
  billedCents: number
  outstandingCents: number
}

type Props = {
  month: string
  properties: Array<{ id: string; code: string; name: string; city: string | null }>
  roll: RollRow[]
  occupancy: {
    asOf: string
    units: number
    occupied: number
    available: number
    unavailable: number
    occupancyBp: number
    contractedRentCents: number
    marketRentCents: number
    voidRentCents: number
  }
  preview: {
    period: { periodStart: string; periodEnd: string; days: number }
    lines: Array<{
      leaseId: string
      propertyName: string
      unitCode: string
      tenantName: string
      amountCents: number
      prorated: boolean
      chargedDays: number
      periodDays: number
    }>
    totalCents: number
    alreadyBilled: number
  }
  charges: Array<{
    id: string
    periodStart: string
    amountCents: number
    prorated: boolean
    invoiceId: string | null
    propertyName: string
    unitCode: string
    tenantName: string
  }>
  deposits: {
    asOf: string
    registerCents: number
    ledgerCents: number
    agrees: boolean
    leases: Array<{
      leaseId: string
      propertyName: string
      unitCode: string
      tenantName: string
      heldCents: number
      requiredCents: number
      shortfallCents: number
    }>
  } | null
  customers: Named[]
  accounts: Named[]
  tenantWord: string
  canManage: boolean
}

/**
 * The properties workspace.
 *
 * Opens on the rent roll rather than on a list of buildings, because the
 * question a landlord opens this to answer is "who is in, who is out, and what
 * is owed" — a list of three addresses answers none of it.
 */
export function PropertiesBoard(props: Props) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [tab, setTab] = useState<'roll' | 'rent' | 'deposits'>('roll')
  const [showNewProperty, setShowNewProperty] = useState(false)

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

  const occupancyPercent = (props.occupancy.occupancyBp / 100).toFixed(1)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Properties</h2>
        <p className="text-sm text-muted">
          {props.occupancy.units} unit{props.occupancy.units === 1 ? '' : 's'} across{' '}
          {props.properties.length} propert{props.properties.length === 1 ? 'y' : 'ies'} ·{' '}
          <span className={props.occupancy.occupied === 0 ? 'text-warning' : 'text-success'}>
            {occupancyPercent}% let
          </span>
          {props.occupancy.voidRentCents > 0 && (
            <>
              {' '}
              · <span className="text-warning">
                {formatCents(props.occupancy.voidRentCents)} of empty units
              </span>
            </>
          )}
        </p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {(
            [
              ['roll', 'Rent roll'],
              ['rent', 'Rent run'],
              ['deposits', 'Deposits held'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`chip px-3 py-1 text-xs ${
                tab === key ? 'bg-brand text-brand-ink' : 'bg-raised text-muted'
              }`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
          {props.canManage && (
            <button
              className="btn btn-ghost text-xs"
              onClick={() => setShowNewProperty((was) => !was)}
            >
              {showNewProperty ? 'Never mind' : 'Add a property'}
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {showNewProperty && props.canManage && (
        <NewProperty act={act} pending={pending} onDone={() => setShowNewProperty(false)} />
      )}

      {tab === 'roll' && (
        <RentRoll
          {...props}
          act={act}
          pending={pending}
          occupancyPercent={occupancyPercent}
        />
      )}
      {tab === 'rent' && <RentRun {...props} act={act} pending={pending} />}
      {tab === 'deposits' && <Deposits {...props} act={act} pending={pending} />}
    </div>
  )
}

type Acting = {
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
}

function NewProperty({
  act,
  pending,
  onDone,
}: Acting & { onDone: () => void }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [city, setCity] = useState('')

  return (
    <section className="card space-y-3 p-4">
      <p className="text-xs text-muted">
        A property becomes an accounting dimension the moment it exists, so everything coded to it
        — rent, repairs, insurance — lands on its own column of the profit and loss.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="ELM"
          className="field w-28"
        />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Elm Street Apartments"
          className="field min-w-48 flex-1"
        />
        <input
          value={city}
          onChange={(event) => setCity(event.target.value)}
          placeholder="City"
          className="field w-40"
        />
        <button
          className="btn btn-primary"
          disabled={pending || !code.trim() || !name.trim()}
          onClick={() => {
            act(() => createPropertyAction({ code, name, city: city || undefined }))
            setCode('')
            setName('')
            setCity('')
            onDone()
          }}
        >
          Add
        </button>
      </div>
    </section>
  )
}

function RentRoll(props: Props & Acting & { occupancyPercent: string }) {
  const [unitFor, setUnitFor] = useState<string | null>(null)
  const [leaseFor, setLeaseFor] = useState<RollRow | null>(null)

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Rent roll</h3>
            <p className="text-xs text-muted">
              Every unit, let or not — {props.occupancy.occupied} of {props.occupancy.units} let,
              {' '}{props.occupancy.available} empty
              {props.occupancy.unavailable > 0 && `, ${props.occupancy.unavailable} held back`}.
            </p>
          </div>
        </header>

        {props.roll.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No units yet. Add a property, then add its units.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Unit</th>
                  <th className="px-4 py-2 font-medium">{props.tenantWord}</th>
                  <th className="px-4 py-2 text-right font-medium">Rent</th>
                  <th className="px-4 py-2 text-right font-medium">Billed</th>
                  <th className="px-4 py-2 text-right font-medium">Owed</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {props.roll.map((row) => (
                  <tr key={row.unitId}>
                    <td className="px-4 py-2">
                      <span className="font-medium">{row.propertyCode} {row.unitCode}</span>
                      <span className="block text-xs text-faint">{row.propertyName}</span>
                    </td>
                    <td className="px-4 py-2">
                      {row.tenantName ?? (
                        <span
                          className={
                            row.status === 'unavailable' ? 'text-muted' : 'text-warning'
                          }
                        >
                          {row.status === 'unavailable' ? 'held back' : 'empty'}
                        </span>
                      )}
                      {row.startsOn && (
                        <span className="block text-xs text-faint">
                          from {row.startsOn}
                          {row.endsOn ? ` to ${row.endsOn}` : ''}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {row.contractedRentCents !== null
                        ? formatCents(row.contractedRentCents)
                        : <span className="text-faint">{formatCents(row.marketRentCents)}</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatCents(row.billedCents)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span className={row.outstandingCents > 0 ? 'text-warning' : ''}>
                        {formatCents(row.outstandingCents)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {props.canManage &&
                        (row.leaseId ? (
                          <button
                            className="btn btn-ghost text-xs"
                            disabled={props.pending}
                            onClick={() => {
                              const endedOn = window.prompt(
                                'End the tenancy on which date? (YYYY-MM-DD)',
                                new Date().toISOString().slice(0, 10),
                              )
                              if (!endedOn) return
                              props.act(() =>
                                endLeaseAction({ leaseId: row.leaseId, endedOn }),
                              )
                            }}
                          >
                            End
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost text-xs"
                            onClick={() => setLeaseFor(row)}
                          >
                            Let it
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {leaseFor && props.canManage && (
        <NewLease
          row={leaseFor}
          customers={props.customers}
          tenantWord={props.tenantWord}
          act={props.act}
          pending={props.pending}
          onDone={() => setLeaseFor(null)}
        />
      )}

      <section className="card p-4">
        <h3 className="text-sm font-semibold">Units</h3>
        <p className="text-xs text-muted">
          Occupancy is measured against units, so an empty flat counts against it. A property with
          four flats and one tenant is 25% let, not 100%.
        </p>
        {props.canManage && props.properties.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              className="field w-56"
              value={unitFor ?? ''}
              onChange={(event) => setUnitFor(event.target.value || null)}
            >
              <option value="">Add a unit to…</option>
              {props.properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.code} — {property.name}
                </option>
              ))}
            </select>
            {unitFor && (
              <NewUnit
                propertyId={unitFor}
                act={props.act}
                pending={props.pending}
                onDone={() => setUnitFor(null)}
              />
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function NewUnit({
  propertyId,
  act,
  pending,
  onDone,
}: Acting & { propertyId: string; onDone: () => void }) {
  const [code, setCode] = useState('')
  const [rent, setRent] = useState('')

  return (
    <>
      <input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="1A"
        className="field w-28"
      />
      <input
        value={rent}
        onChange={(event) => setRent(event.target.value)}
        placeholder="Market rent"
        className="field w-36"
        inputMode="decimal"
      />
      <button
        className="btn btn-primary"
        disabled={pending || !code.trim()}
        onClick={() => {
          act(() =>
            createUnitAction({
              propertyId,
              code,
              marketRentCents: Math.round(Number(rent || '0') * 100),
            }),
          )
          setCode('')
          setRent('')
          onDone()
        }}
      >
        Add unit
      </button>
    </>
  )
}

function NewLease({
  row,
  customers,
  tenantWord,
  act,
  pending,
  onDone,
}: Acting & {
  row: RollRow
  customers: Named[]
  tenantWord: string
  onDone: () => void
}) {
  const [customerId, setCustomerId] = useState('')
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10))
  const [rent, setRent] = useState((row.marketRentCents / 100).toFixed(2))
  const [deposit, setDeposit] = useState((row.marketRentCents / 100).toFixed(2))
  const [dueDay, setDueDay] = useState('1')

  return (
    <section className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold">
        Let {row.propertyCode} {row.unitCode}
      </h3>
      <div className="flex flex-wrap gap-2">
        <select
          className="field w-56"
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
        >
          <option value="">Which {tenantWord.toLowerCase()}?</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={startsOn}
          onChange={(event) => setStartsOn(event.target.value)}
          className="field w-40"
        />
        <input
          value={rent}
          onChange={(event) => setRent(event.target.value)}
          placeholder="Monthly rent"
          className="field w-36"
          inputMode="decimal"
        />
        <input
          value={deposit}
          onChange={(event) => setDeposit(event.target.value)}
          placeholder="Deposit"
          className="field w-32"
          inputMode="decimal"
        />
        <select
          className="field w-32"
          value={dueDay}
          onChange={(event) => setDueDay(event.target.value)}
        >
          {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
            <option key={day} value={day}>
              Due on the {day}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={pending || !customerId || Number(rent) <= 0}
          onClick={() => {
            act(() =>
              createLeaseAction({
                unitId: row.unitId,
                customerId,
                startsOn,
                rentCents: Math.round(Number(rent) * 100),
                depositRequiredCents: Math.round(Number(deposit || '0') * 100),
                dueDay: Number(dueDay),
                activate: true,
              }),
            )
            onDone()
          }}
        >
          Start the tenancy
        </button>
        <button className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  )
}

function RentRun(props: Props & Acting) {
  const [month, setMonth] = useState(props.month.slice(0, 7))

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h3 className="text-sm font-semibold">Rent run</h3>
        <p className="text-xs text-muted">
          One invoice per tenancy for the month, prorated when a tenancy starts or ends part way
          through. Running it twice bills once — the second attempt loses on a unique index rather
          than being filtered out and hoped over.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="field w-44"
          />
          <a className="btn btn-ghost text-xs" href={`/properties?month=${month}-01`}>
            Preview
          </a>
          {props.canManage && (
            <button
              className="btn btn-primary"
              disabled={props.pending || props.preview.lines.length === 0}
              onClick={() => props.act(() => runRentAction({ month: `${month}-01` }))}
            >
              Bill {props.preview.lines.length || 'nothing'}
              {props.preview.lines.length > 0 && ` — ${formatCents(props.preview.totalCents)}`}
            </button>
          )}
        </div>

        {props.preview.alreadyBilled > 0 && (
          <p className="mt-2 text-xs text-muted">
            {props.preview.alreadyBilled} tenanc{props.preview.alreadyBilled === 1 ? 'y' : 'ies'}{' '}
            already billed for {props.preview.period.periodStart.slice(0, 7)}.
          </p>
        )}

        {props.preview.lines.length > 0 && (
          <ul className="mt-3 divide-y divide-line text-sm">
            {props.preview.lines.map((line) => (
              <li key={line.leaseId} className="flex justify-between gap-3 py-1.5">
                <span>
                  {line.propertyName} {line.unitCode}
                  <span className="text-xs text-faint"> · {line.tenantName}</span>
                  {line.prorated && (
                    <span className="ml-2 text-xs text-warning">
                      prorated {line.chargedDays}/{line.periodDays} days
                    </span>
                  )}
                </span>
                <span className="tabular-nums">{formatCents(line.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">Billed</h3>
        </header>
        {props.charges.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Nothing billed yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {props.charges.map((charge) => (
              <li key={charge.id} className="flex justify-between gap-3 px-4 py-2">
                <span>
                  <span className="text-xs text-faint">{charge.periodStart.slice(0, 7)}</span>{' '}
                  {charge.propertyName} {charge.unitCode}
                  <span className="text-xs text-faint"> · {charge.tenantName}</span>
                  {charge.prorated && <span className="ml-2 text-xs text-warning">prorated</span>}
                </span>
                <span className="tabular-nums">{formatCents(charge.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Deposits(props: Props & Acting) {
  const [movingFor, setMovingFor] = useState<string | null>(null)

  if (!props.deposits) {
    return (
      <section className="card p-8 text-center text-sm text-muted">
        Your role does not include financial reports, so the deposits reconciliation is hidden.
      </section>
    )
  }

  const { deposits } = props

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h3 className="text-sm font-semibold">Deposits held</h3>
        <p className="text-xs text-muted">
          A deposit is the tenant&rsquo;s money, held. It is a liability from the day it arrives and
          never touches the profit and loss — until it is kept for something nothing has billed,
          which is the one moment it becomes income.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Stat label="Register" value={formatCents(deposits.registerCents)} />
          <Stat label="Account 2580" value={formatCents(deposits.ledgerCents)} />
          <Stat
            label="Agrees"
            value={deposits.agrees ? 'Yes' : 'No'}
            tone={deposits.agrees ? 'success' : 'danger'}
          />
        </div>

        {!deposits.agrees && (
          <p className="mt-2 text-xs text-danger">
            The deposits recorded against tenancies do not match the liability on the balance
            sheet. Something has been posted to 2580 outside this module.
          </p>
        )}
      </section>

      <section className="card overflow-hidden">
        {deposits.leases.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No deposits held.</p>
        ) : (
          <ul className="divide-y divide-line">
            {deposits.leases.map((row) => (
              <li key={row.leaseId} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm">
                    {row.propertyName} {row.unitCode}
                    <span className="text-xs text-faint"> · {row.tenantName}</span>
                  </span>
                  <span className="tabular-nums">
                    {formatCents(row.heldCents)}
                    {row.shortfallCents > 0 && (
                      <span className="ml-2 text-xs text-warning">
                        {formatCents(row.shortfallCents)} short of the agreed deposit
                      </span>
                    )}
                  </span>
                </div>

                {props.canManage && (
                  <div className="mt-1.5">
                    <button
                      className="text-xs text-brand hover:underline"
                      onClick={() =>
                        setMovingFor(movingFor === row.leaseId ? null : row.leaseId)
                      }
                    >
                      {movingFor === row.leaseId ? 'Close' : 'Take, return or keep'}
                    </button>

                    {movingFor === row.leaseId && (
                      <DepositMovement
                        leaseId={row.leaseId}
                        accounts={props.accounts}
                        act={props.act}
                        pending={props.pending}
                        onDone={() => setMovingFor(null)}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function DepositMovement({
  leaseId,
  accounts,
  act,
  pending,
  onDone,
}: Acting & { leaseId: string; accounts: Named[]; onDone: () => void }) {
  const [amount, setAmount] = useState('')
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10))
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [memo, setMemo] = useState('')

  const cents = Math.round(Number(amount || '0') * 100)
  const ready = cents > 0

  return (
    <div className="mt-2 flex flex-wrap gap-2 rounded-lg bg-raised/40 p-3">
      <input
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        placeholder="Amount"
        className="field w-32 py-1 text-xs"
        inputMode="decimal"
      />
      <input
        type="date"
        value={occurredOn}
        onChange={(event) => setOccurredOn(event.target.value)}
        className="field w-36 py-1 text-xs"
      />
      <select
        className="field w-44 py-1 text-xs"
        value={accountId}
        onChange={(event) => setAccountId(event.target.value)}
      >
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
      <input
        value={memo}
        onChange={(event) => setMemo(event.target.value)}
        placeholder="What for?"
        className="field min-w-40 flex-1 py-1 text-xs"
      />
      <button
        className="btn btn-ghost text-xs"
        disabled={pending || !ready || !accountId}
        onClick={() => {
          act(() =>
            receiveDepositAction({
              leaseId,
              amountCents: cents,
              occurredOn,
              financialAccountId: accountId,
              memo: memo || undefined,
            }),
          )
          onDone()
        }}
      >
        Take it
      </button>
      <button
        className="btn btn-ghost text-xs"
        disabled={pending || !ready || !accountId}
        onClick={() => {
          act(() =>
            refundDepositAction({
              leaseId,
              amountCents: cents,
              occurredOn,
              financialAccountId: accountId,
              memo: memo || undefined,
            }),
          )
          onDone()
        }}
      >
        Give it back
      </button>
      <button
        className="btn btn-ghost text-xs"
        disabled={pending || !ready}
        title="Kept against damage. This is the moment it becomes income."
        onClick={() => {
          act(() =>
            applyDepositAction({
              leaseId,
              amountCents: cents,
              occurredOn,
              memo: memo || undefined,
            }),
          )
          onDone()
        }}
      >
        Keep it
      </button>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'success' | 'danger'
}) {
  return (
    <div className="rounded-lg bg-raised/40 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p
        className={`text-lg font-semibold tabular-nums ${
          tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : ''
        }`}
      >
        {value}
      </p>
    </div>
  )
}
