'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  addDrawerAction,
  closeShiftAction,
  openShiftAction,
  payOutAction,
  type ActionResult,
} from '@/app/actions/drawers'

type Drawer = {
  id: string
  name: string
  defaultFloatCents: number
  isActive: boolean
  openShiftId: string | null
}

type OpenShift = {
  shiftId: string
  drawerName: string
  openedAt: string
  openedByName: string | null
  floatCents: number
  takingsCents: number
  paidOutCents: number
  expectedCents: number
  takingCount: number
  payouts: Array<{ id: string; reason: string; amountCents: number }>
}

type HistoryRow = {
  id: string
  drawerName: string
  status: string
  openedAt: string
  closedAt: string | null
  floatCents: number
  countedCents: number | null
  expectedCents: number | null
  overShortCents: number | null
  openedByName: string | null
}

type Props = {
  drawers: Drawer[]
  open: OpenShift[]
  history: HistoryRow[]
  position: {
    registerCents: number
    ledgerCents: number
    differenceCents: number
    agrees: boolean
    tills: Array<{
      drawerId: string
      drawerName: string
      openShiftId: string | null
      expectedCents: number
    }>
  } | null
  expenseAccounts: Array<{ id: string; number: string; name: string }>
  canManage: boolean
  canAddDrawers: boolean
}

type Helpers = { act: (fn: () => Promise<ActionResult>) => void; pending: boolean }

function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/**
 * The tills workspace (spec §5, §13, Phase 34).
 *
 * Opens on what is currently open, because the question somebody has this
 * screen up to answer is either "start my shift" or "count this drawer", and
 * both are about a till that is open right now. History is underneath, where a
 * manager looking at how the week went can find it.
 */
export function DrawersBoard(props: Props) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showNew, setShowNew] = useState(false)

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

  const shut = props.drawers.filter((row) => row.isActive && !row.openShiftId)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Tills</h2>
        <p className="text-sm text-muted">
          {props.open.length} open ·{' '}
          {formatCents(props.open.reduce((sum, row) => sum + row.expectedCents, 0))} expected in
          them
        </p>

        {props.canAddDrawers && (
          <div className="mt-2">
            <button className="btn text-xs" onClick={() => setShowNew((v) => !v)}>
              {showNew ? 'Never mind' : 'Add a till'}
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

      {showNew && props.canAddDrawers && (
        <form
          className="card space-y-3 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            act(() =>
              addDrawerAction({
                name: String(form.get('name')),
                defaultFloatCents: Math.round(Number(form.get('float') ?? 0) * 100),
              }),
            )
            setShowNew(false)
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs">
              <span className="block text-faint">What it is called</span>
              <input className="field" name="name" placeholder="Front counter" required />
            </label>
            <label className="text-xs">
              <span className="block text-faint">Usual float</span>
              <input className="field" defaultValue="100.00" name="float" step="0.01" type="number" />
            </label>
          </div>
          <button className="btn btn-primary text-xs" disabled={pending} type="submit">
            Add it
          </button>
        </form>
      )}

      {props.open.map((shift) => (
        <OpenTill
          key={shift.shiftId}
          shift={shift}
          act={act}
          pending={pending}
          canManage={props.canManage}
          expenseAccounts={props.expenseAccounts}
        />
      ))}

      {shut.length > 0 && (
        <section className="card overflow-hidden">
          <header className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold">Not open</h3>
            <p className="text-xs text-muted">
              A float is the shop&rsquo;s own money moved out of petty cash so the first customer
              with a twenty can be given change. Nothing is earned by opening a till.
            </p>
          </header>
          <ul className="divide-y divide-line">
            {shut.map((drawer) => (
              <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={drawer.id}>
                <div>
                  <p className="text-sm font-medium">{drawer.name}</p>
                  <p className="text-xs text-faint">
                    usually opens with {formatCents(drawer.defaultFloatCents)}
                  </p>
                </div>
                {props.canManage && (
                  <OpenForm
                    drawer={drawer}
                    act={act}
                    pending={pending}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.position && (
        <section className="card px-4 py-3">
          <h3 className="text-sm font-semibold">Do the tills agree with the books?</h3>
          <p className="mt-1 text-xs text-muted">
            The left is what every till should physically hold: an open shift&rsquo;s float plus
            what it kept less what it paid out, and for a shut one, the float its last shift left
            in. The right is what account 1060 holds. Nothing legitimately moves them
            apart, so a difference means cash was journalled into a till by hand, or a shift closed
            without its entry. Checked nightly since Phase 33.
          </p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-faint">The tills say</dt>
              <dd className="text-lg tabular-nums">{formatCents(props.position.registerCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">The ledger says</dt>
              <dd className="text-lg tabular-nums">{formatCents(props.position.ledgerCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Agrees</dt>
              <dd
                className={`text-lg font-semibold ${
                  props.position.agrees ? 'text-success' : 'text-danger'
                }`}
              >
                {props.position.agrees
                  ? 'Yes'
                  : `No — ${formatCents(Math.abs(props.position.differenceCents))} apart`}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">Shifts</h3>
          <p className="text-xs text-muted">
            A count is what somebody said was in a drawer at a moment. It is never adjusted
            afterwards — correcting a genuine mis-count is a journal entry with a memo saying so.
          </p>
        </header>
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Till</th>
              <th className="px-4 py-2">Who</th>
              <th className="px-4 py-2">Opened</th>
              <th className="px-4 py-2">Expected</th>
              <th className="px-4 py-2">Counted</th>
              <th className="px-4 py-2">Over / short</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {props.history.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={6}>
                  No till has been opened yet.
                </td>
              </tr>
            )}
            {props.history.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-2">{row.drawerName}</td>
                <td className="px-4 py-2">{row.openedByName ?? <span className="text-faint">—</span>}</td>
                <td className="px-4 py-2 tabular-nums text-xs">{when(row.openedAt)}</td>
                <td className="px-4 py-2 tabular-nums">
                  {row.expectedCents === null ? (
                    <span className="text-faint">still open</span>
                  ) : (
                    formatCents(row.expectedCents)
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {row.countedCents === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    formatCents(row.countedCents)
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  <OverShort cents={row.overShortCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function OverShort({ cents }: { cents: number | null }) {
  if (cents === null) return <span className="text-faint">—</span>
  if (cents === 0) return <span className="text-success">balanced</span>
  return (
    <span className="text-danger">
      {formatCents(Math.abs(cents))} {cents > 0 ? 'over' : 'short'}
    </span>
  )
}

function OpenForm({ drawer, act, pending }: Helpers & { drawer: Drawer }) {
  const [float, setFloat] = useState((drawer.defaultFloatCents / 100).toFixed(2))

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        act(() =>
          openShiftAction({
            drawerId: drawer.id,
            floatCents: Math.round(Number(float) * 100) || 0,
          }),
        )
      }}
    >
      <label className="text-xs">
        <span className="block text-faint">Float</span>
        <input
          className="field w-24"
          min="0"
          onChange={(event) => setFloat(event.target.value)}
          step="0.01"
          type="number"
          value={float}
        />
      </label>
      <button className="btn btn-primary text-xs" disabled={pending} type="submit">
        Open
      </button>
    </form>
  )
}

/**
 * One open till, with what it should hold and the control that counts it.
 *
 * The expected figure is shown *next to* the box somebody types into, and the
 * difference appears as they type. That is deliberate and it is the one place
 * where showing the answer first would be wrong — so the count field starts
 * **empty** rather than pre-filled with what was expected. A pre-filled count
 * is not a count.
 */
function OpenTill({
  shift,
  act,
  pending,
  canManage,
  expenseAccounts,
}: Helpers & {
  shift: OpenShift
  canManage: boolean
  expenseAccounts: Array<{ id: string; number: string; name: string }>
}) {
  const [counted, setCounted] = useState('')
  const [retain, setRetain] = useState((shift.floatCents / 100).toFixed(2))
  const [showPayout, setShowPayout] = useState(false)

  const countedCents = counted.trim() === '' ? null : Math.round(Number(counted) * 100) || 0
  const overShortCents = countedCents === null ? null : countedCents - shift.expectedCents

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{shift.drawerName}</h3>
        <p className="text-xs text-muted">
          {shift.openedByName ?? 'Somebody'} opened it at {when(shift.openedAt)} ·{' '}
          {shift.takingCount} payment{shift.takingCount === 1 ? '' : 's'} in
        </p>
      </header>

      <dl className="grid gap-3 px-4 py-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-faint">Float</dt>
          <dd className="tabular-nums">{formatCents(shift.floatCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Taken in cash</dt>
          <dd className="tabular-nums">{formatCents(shift.takingsCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Paid out</dt>
          <dd className="tabular-nums">{formatCents(shift.paidOutCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Should hold</dt>
          <dd className="tabular-nums text-lg font-semibold">
            {formatCents(shift.expectedCents)}
          </dd>
        </div>
      </dl>

      {shift.payouts.length > 0 && (
        <ul className="border-t border-line px-4 py-2 text-xs text-muted">
          {shift.payouts.map((payout) => (
            <li key={payout.id}>
              {formatCents(payout.amountCents)} — {payout.reason}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="border-t border-line px-4 py-3">
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (countedCents === null) return
              act(() =>
                closeShiftAction({
                  shiftId: shift.shiftId,
                  countedCents,
                  retainFloatCents: Math.round(Number(retain) * 100) || 0,
                }),
              )
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs">
                <span className="block text-faint">Counted in the drawer</span>
                <input
                  className="field"
                  min="0"
                  onChange={(event) => setCounted(event.target.value)}
                  placeholder="what is actually there"
                  step="0.01"
                  type="number"
                  value={counted}
                />
              </label>
              <label className="text-xs">
                <span className="block text-faint">Leave in for next time</span>
                <input
                  className="field"
                  min="0"
                  onChange={(event) => setRetain(event.target.value)}
                  step="0.01"
                  type="number"
                  value={retain}
                />
              </label>
              <div className="flex items-end">
                <button
                  className="btn btn-primary text-xs"
                  disabled={pending || countedCents === null}
                  type="submit"
                >
                  Count it and close
                </button>
              </div>
            </div>

            <p className="text-xs">
              {overShortCents === null ? (
                <span className="text-faint">
                  Type what is in the drawer. Nothing is filled in for you — a count that was
                  suggested is not a count.
                </span>
              ) : overShortCents === 0 ? (
                <span className="text-success">It balances.</span>
              ) : (
                <span className="text-warning">
                  {formatCents(Math.abs(overShortCents))} {overShortCents > 0 ? 'over' : 'short'}.
                  This will be posted to <strong>6870 Cash Over and Short</strong>, not absorbed.
                </span>
              )}
            </p>
          </form>

          <div className="mt-3">
            <button className="btn btn-ghost text-xs" onClick={() => setShowPayout((v) => !v)}>
              {showPayout ? 'Never mind' : 'Pay something out of the till'}
            </button>
          </div>

          {showPayout && (
            <form
              className="mt-2 grid gap-2 sm:grid-cols-4"
              onSubmit={(event) => {
                event.preventDefault()
                const form = new FormData(event.currentTarget)
                act(() =>
                  payOutAction({
                    shiftId: shift.shiftId,
                    reason: String(form.get('reason')),
                    amountCents: Math.round(Number(form.get('amount')) * 100),
                    chartAccountId: String(form.get('account')),
                  }),
                )
                setShowPayout(false)
              }}
            >
              <label className="text-xs sm:col-span-2">
                <span className="block text-faint">What for</span>
                <input className="field" name="reason" placeholder="Window cleaner" required />
              </label>
              <label className="text-xs">
                <span className="block text-faint">How much</span>
                <input className="field" min="0.01" name="amount" step="0.01" type="number" required />
              </label>
              <label className="text-xs">
                <span className="block text-faint">Where it lands</span>
                <select className="field" name="account" required>
                  {expenseAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.number} {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="sm:col-span-4">
                <button className="btn text-xs" disabled={pending} type="submit">
                  Record it
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  )
}
