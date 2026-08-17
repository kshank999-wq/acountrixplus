'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  dayDetailAction,
  importDayAction,
  type ActionResult,
  type DayDetail,
} from '@/app/actions/takings'

type Day = {
  id: string
  businessDate: string
  source: string
  label: string | null
  grossSalesCents: number
  netSalesCents: number
  discountsCents: number
  refundsCents: number
  taxCents: number
  tipsCents: number
  feeCents: number
  takingsCents: number
  overShortCents: number | null
  outOfBalanceCents: number
  journalEntryId: string | null
}

type Props = {
  days: Day[]
  tips: {
    collectedCents: number
    ledgerCents: number
    paidOutCents: number
    agrees: boolean
  } | null
  revenueAccounts: Array<{ number: string; name: string }>
  today: string
  canManage: boolean
}

/**
 * The takings workspace (spec §5, Phase 28).
 *
 * Opens on the days rather than on a form, because the question somebody opens
 * this to answer is "did yesterday go in, and was the till right" — and a blank
 * import form answers neither.
 */
export function TakingsBoard(props: Props) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showImport, setShowImport] = useState(false)
  const [openDayId, setOpenDayId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DayDetail | null>(null)

  function toggleDay(id: string) {
    if (openDayId === id) {
      setOpenDayId(null)
      return
    }
    setOpenDayId(id)
    setDetail(null)
    startTransition(async () => {
      setDetail(await dayDetailAction(id))
    })
  }

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

  const short = props.days.filter(
    (day) => day.overShortCents !== null && day.overShortCents !== 0,
  )
  const netTotal = props.days.reduce((sum, day) => sum + day.netSalesCents, 0)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Takings</h2>
        <p className="text-sm text-muted">
          {props.days.length} day{props.days.length === 1 ? '' : 's'} imported ·{' '}
          {formatCents(netTotal)} net sales
          {short.length > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="text-warning">
                {short.length} till{short.length === 1 ? '' : 's'} did not agree
              </span>
            </>
          )}
        </p>

        {props.canManage && (
          <div className="mt-2">
            <button
              className="btn btn-ghost text-xs"
              onClick={() => setShowImport((was) => !was)}
            >
              {showImport ? 'Never mind' : 'Import a day'}
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

      {showImport && props.canManage && (
        <ImportForm {...props} act={act} pending={pending} onDone={() => setShowImport(false)} />
      )}

      {props.tips && (
        <div className="card px-4 py-3">
          <h3 className="text-sm font-semibold">Tips</h3>
          <p className="mt-1 text-xs text-muted">
            Collected from customers on staff&rsquo;s behalf. A liability from the moment it is
            taken, and never the business&rsquo;s revenue — so it appears on no profit and loss at
            all.
          </p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-faint">Collected</dt>
              <dd className="text-lg tabular-nums">{formatCents(props.tips.collectedCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Still owed (account 2310)</dt>
              <dd className="text-lg tabular-nums text-warning">
                {formatCents(props.tips.ledgerCents)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Paid out</dt>
              <dd className="text-lg tabular-nums">{formatCents(props.tips.paidOutCents)}</dd>
            </div>
          </dl>
          {props.tips.paidOutCents === 0 && props.tips.collectedCents > 0 && (
            <p className="mt-2 text-xs text-warning">
              Nothing has been paid out yet. Tips leave this account through payroll.
            </p>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Day</th>
              <th className="px-4 py-2">Net sales</th>
              <th className="px-4 py-2">Tax</th>
              <th className="px-4 py-2">Tips</th>
              <th className="px-4 py-2">Fees</th>
              <th className="px-4 py-2">Till</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {props.days.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={6}>
                  No days imported yet. A day becomes one journal entry, not four hundred.
                </td>
              </tr>
            )}
            {props.days.map((day) => (
              <Fragment key={day.id}>
              <tr
                className="cursor-pointer hover:bg-raised/40"
                onClick={() => toggleDay(day.id)}
              >
                <td className="px-4 py-2">
                  <span className="tabular-nums">{day.businessDate}</span>
                  <span className="block text-xs text-faint">
                    {day.source}
                    {day.label && ` · ${day.label}`}
                    {day.discountsCents > 0 && ` · ${formatCents(day.discountsCents)} discounted`}
                    {day.refundsCents > 0 && ` · ${formatCents(day.refundsCents)} refunded`}
                  </span>
                </td>
                <td className="px-4 py-2 tabular-nums">{formatCents(day.netSalesCents)}</td>
                <td className="px-4 py-2 tabular-nums">{formatCents(day.taxCents)}</td>
                <td className="px-4 py-2 tabular-nums">{formatCents(day.tipsCents)}</td>
                <td className="px-4 py-2 tabular-nums">
                  {day.feeCents > 0 ? (
                    <span className="text-warning">{formatCents(day.feeCents)}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {day.overShortCents === null ? (
                    <span className="text-xs text-faint">not counted</span>
                  ) : day.overShortCents === 0 ? (
                    <span className="text-success">exact</span>
                  ) : (
                    <span className="text-danger">
                      {day.overShortCents < 0
                        ? `${formatCents(-day.overShortCents)} short`
                        : `${formatCents(day.overShortCents)} over`}
                    </span>
                  )}
                  {day.outOfBalanceCents !== 0 && (
                    <span className="block text-xs text-danger">
                      summary out by {formatCents(Math.abs(day.outOfBalanceCents))}, in 1220
                    </span>
                  )}
                </td>
              </tr>
              {openDayId === day.id && (
                <tr>
                  <td className="bg-raised/30 px-4 py-3" colSpan={6}>
                    <DayBreakdown day={day} detail={detail} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-faint">
        Card takings land in Payment Processor Clearing at the <strong>net</strong> deposit, with
        the fee debited separately — so the revenue is still the gross. Booking the deposit would
        lose both the sales and the fee.
      </p>
    </div>
  )
}

/**
 * What the source actually said, under the row that summarises it.
 *
 * Both halves are shown side by side deliberately: what was sold on the left,
 * how it was paid for on the right, and the two totals underneath. When a
 * summary is out, this is the screen on which somebody can see *which* of the
 * two numbers is wrong — which the day row, showing only the difference,
 * cannot tell them.
 */
function DayBreakdown({ day, detail }: { day: Day; detail: DayDetail | null }) {
  if (!detail) {
    return <p className="text-xs text-faint">Loading what the day was made of…</p>
  }

  const takings = detail.tenders.reduce((sum, tender) => sum + tender.amountCents, 0)

  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-faint">Sold</h4>
        <ul className="mt-2 space-y-1 text-sm">
          {detail.categories.map((category) => (
            <li className="flex justify-between gap-4" key={`${category.accountNumber}-${category.name}`}>
              <span>
                {category.name}
                <span className="ml-1 text-xs text-faint">{category.accountNumber}</span>
              </span>
              <span className="tabular-nums">{formatCents(category.amountCents)}</span>
            </li>
          ))}
          {day.discountsCents > 0 && (
            <li className="flex justify-between gap-4 text-muted">
              <span>Discounts allowed</span>
              <span className="tabular-nums">−{formatCents(day.discountsCents)}</span>
            </li>
          )}
          {day.refundsCents > 0 && (
            <li className="flex justify-between gap-4 text-muted">
              <span>Refunds given</span>
              <span className="tabular-nums">−{formatCents(day.refundsCents)}</span>
            </li>
          )}
          <li className="flex justify-between gap-4 border-t border-line pt-1 font-medium">
            <span>Net sales</span>
            <span className="tabular-nums">{formatCents(day.netSalesCents)}</span>
          </li>
        </ul>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-faint">Taken</h4>
        <ul className="mt-2 space-y-1 text-sm">
          {detail.tenders.map((tender) => (
            <li className="flex justify-between gap-4" key={`${tender.kind}-${tender.name}`}>
              <span>
                {tender.name}
                <span className="ml-1 text-xs text-faint">{tender.kind}</span>
                {tender.feeCents > 0 && (
                  <span className="ml-1 text-xs text-warning">
                    less {formatCents(tender.feeCents)} fee
                  </span>
                )}
              </span>
              <span className="tabular-nums">{formatCents(tender.amountCents)}</span>
            </li>
          ))}
          <li className="flex justify-between gap-4 border-t border-line pt-1 font-medium">
            <span>Taken, including tax and tips</span>
            <span className="tabular-nums">{formatCents(takings)}</span>
          </li>
        </ul>

        {day.outOfBalanceCents !== 0 && (
          <p className="mt-2 text-xs text-danger">
            These two do not reconcile: the tills took{' '}
            {formatCents(Math.abs(day.outOfBalanceCents))}{' '}
            {day.outOfBalanceCents > 0 ? 'more' : 'less'} than the day sold. The difference is in
            1220 POS Import Suspense until somebody works out which side is wrong.
          </p>
        )}
      </div>
    </div>
  )
}

type Helpers = { act: (fn: () => Promise<ActionResult>) => void; pending: boolean }

function ImportForm({
  revenueAccounts,
  today,
  act,
  pending,
  onDone,
}: Props & Helpers & { onDone: () => void }) {
  const [categories, setCategories] = useState([{ name: '', accountNumber: '', amount: '' }])

  return (
    <form
      className="card space-y-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const money = (key: string) => Math.round(Number(form.get(key) ?? 0) * 100) || 0
        const countedRaw = String(form.get('countedCash') ?? '')

        act(() =>
          importDayAction({
            businessDate: String(form.get('businessDate')),
            source: String(form.get('source')) as 'register',
            label: String(form.get('label') ?? ''),
            categories: categories
              .filter((row) => row.name && row.accountNumber && Number(row.amount) > 0)
              .map((row) => ({
                name: row.name,
                accountNumber: row.accountNumber,
                amountCents: Math.round(Number(row.amount) * 100),
              })),
            tenders: [
              { kind: 'cash' as const, name: 'Cash', amountCents: money('cash'), feeCents: 0 },
              {
                kind: 'card' as const,
                name: 'Card',
                amountCents: money('card'),
                feeCents: money('cardFee'),
              },
            ].filter((tender) => tender.amountCents > 0),
            taxCents: money('tax'),
            tipsCents: money('tips'),
            discountsCents: money('discounts'),
            refundsCents: money('refunds'),
            // An empty box means nobody counted, which is not the same as
            // counting and finding zero difference.
            countedCashCents: countedRaw === '' ? null : Math.round(Number(countedRaw) * 100),
            floatCents: money('float'),
          }),
        )
        onDone()
      }}
    >
      <h3 className="text-sm font-semibold">Import a day</h3>
      <p className="text-xs text-muted">
        One day, one entry. Importing the same day twice posts nothing the second time — the
        database refuses it.
      </p>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="block text-faint">Trading day</span>
          <input className="field" type="date" name="businessDate" defaultValue={today} required />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Source</span>
          <select className="field" name="source" defaultValue="register">
            <option value="register">Till</option>
            <option value="marketplace">Marketplace</option>
            <option value="processor">Processor</option>
            <option value="manual">Typed in</option>
          </select>
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="block text-faint">Which till or platform</span>
          <input className="field" name="label" placeholder="Front counter" />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-faint">Sales by category</p>
        {categories.map((row, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-4">
            <input
              className="field text-xs sm:col-span-2"
              placeholder="Food"
              value={row.name}
              onChange={(event) => {
                const next = [...categories]
                next[index] = { ...row, name: event.target.value }
                setCategories(next)
              }}
            />
            <select
              className="field text-xs"
              value={row.accountNumber}
              onChange={(event) => {
                const next = [...categories]
                next[index] = { ...row, accountNumber: event.target.value }
                setCategories(next)
              }}
            >
              <option value="">Account</option>
              {revenueAccounts.map((account) => (
                <option key={account.number} value={account.number}>
                  {account.number} {account.name}
                </option>
              ))}
            </select>
            <input
              className="field text-xs"
              type="number"
              step="0.01"
              placeholder="0.00"
              value={row.amount}
              onChange={(event) => {
                const next = [...categories]
                next[index] = { ...row, amount: event.target.value }
                setCategories(next)
              }}
            />
          </div>
        ))}
        <button
          className="btn btn-ghost text-xs"
          type="button"
          onClick={() => setCategories([...categories, { name: '', accountNumber: '', amount: '' }])}
        >
          Another category
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="block text-faint">Sales tax</span>
          <input className="field" type="number" step="0.01" name="tax" defaultValue="0" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Tips</span>
          <input className="field" type="number" step="0.01" name="tips" defaultValue="0" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Discounts</span>
          <input className="field" type="number" step="0.01" name="discounts" defaultValue="0" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Refunds</span>
          <input className="field" type="number" step="0.01" name="refunds" defaultValue="0" />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="block text-faint">Cash taken</span>
          <input className="field" type="number" step="0.01" name="cash" defaultValue="0" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Card taken</span>
          <input className="field" type="number" step="0.01" name="card" defaultValue="0" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Card fees</span>
          <input className="field" type="number" step="0.01" name="cardFee" defaultValue="0" />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Float in the drawer</span>
          <input className="field" type="number" step="0.01" name="float" defaultValue="0" />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="block text-faint">Cash actually counted</span>
          <input className="field" type="number" step="0.01" name="countedCash" placeholder="Leave blank if nobody counted" />
        </label>
      </div>

      <button className="btn text-sm" type="submit" disabled={pending}>
        Import it
      </button>
    </form>
  )
}
