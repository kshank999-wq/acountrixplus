'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  EvidencePanel,
  type EvidenceItemView,
  type NoteView,
} from '@/components/evidence-panel'
import {
  disposeAssetAction,
  registerAssetAction,
  runDepreciationAction,
  type ActionResult,
} from '@/app/actions/dimensions'
import {
  ASSET_STATUS_LABELS,
  CONVENTION_HINTS,
  CONVENTION_LABELS,
  METHOD_HINTS,
  METHOD_LABELS,
} from '@/modules/dimensions/vocabulary'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Asset = {
  id: string
  tag: string
  name: string
  category: string | null
  costCents: number
  accumulatedCents: number
  bookValueCents: number
  method: string
  convention: string
  lifeMonths: number
  inServiceDate: string
  status: 'active' | 'fully_depreciated' | 'disposed'
  depreciatedThrough: string | null
  disposedOn: string | null
}

type Due = {
  assetId: string
  tag: string
  name: string
  periodEnd: string
  amountCents: number
}

type Reconciliation = {
  asOf: string
  registerCostCents: number
  ledgerCostCents: number
  costAgrees: boolean
  registerAccumulatedCents: number
  ledgerAccumulatedCents: number
  accumulatedAgrees: boolean
  agrees: boolean
  registerBookValueCents: number
}

type Named = { id: string; name: string }

/**
 * The fixed asset register.
 *
 * Ordered by what somebody actually needs to know: does the register agree
 * with the books, what is owed, and only then the list of things owned.
 */
export function AssetBoard({
  today,
  register,
  due,
  reconciliation,
  banks,
  evidence,
  notes,
  canPost,
}: {
  today: string
  register: Asset[]
  due: Due[]
  reconciliation: Reconciliation
  banks: Named[]
  evidence: Record<string, EvidenceItemView[]>
  notes: Record<string, NoteView[]>
  canPost: boolean
}) {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showRegister, setShowRegister] = useState(false)
  const [disposing, setDisposing] = useState<string | null>(null)
  const [showingPaperwork, setShowingPaperwork] = useState<string | null>(null)

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) setDisposing(null)
    })
  }

  const owedCents = due.reduce((sum, row) => sum + row.amountCents, 0)
  const owedMonths = new Set(due.map((row) => row.periodEnd)).size
  const oldestOwed = due.length > 0 ? due[0].periodEnd : null

  const live = register.filter((asset) => asset.status !== 'disposed')

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Fixed assets</h2>
        <p className="text-sm text-muted">
          What the company owns and writes off over time.{' '}
          <span className="text-faint">
            Registering an asset posts nothing — the purchase was already coded when the bill was
            entered.
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

      {/* The finding, first. Nothing else in the application can tell you this. */}
      <section
        className={`card px-4 py-3 ${reconciliation.agrees ? '' : 'border-warning'}`}
        aria-label="Register against the ledger"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">The register against the ledger</h3>
          <span
            className={`text-sm font-medium ${
              reconciliation.agrees ? 'text-success' : 'text-warning'
            }`}
          >
            {reconciliation.agrees ? 'They agree' : 'They disagree'}
          </span>
        </div>

        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1 font-medium" />
              <th className="py-1 text-right font-medium">Register</th>
              <th className="py-1 text-right font-medium">Ledger</th>
              <th className="py-1 text-right font-medium">Difference</th>
            </tr>
          </thead>
          <tbody>
            <ReconRow
              label="Cost"
              register={reconciliation.registerCostCents}
              ledger={reconciliation.ledgerCostCents}
              agrees={reconciliation.costAgrees}
            />
            <ReconRow
              label="Accumulated depreciation"
              register={reconciliation.registerAccumulatedCents}
              ledger={reconciliation.ledgerAccumulatedCents}
              agrees={reconciliation.accumulatedAgrees}
            />
            <tr className="border-t border-line font-medium">
              <td className="py-1.5">Book value</td>
              <td className="tnum py-1.5 text-right">
                {formatCents(reconciliation.registerBookValueCents)}
              </td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>

        {!reconciliation.agrees && (
          <p className="mt-2 text-xs text-muted">
            The ledger is the authority and the register is the explanation. A difference means
            something was coded to Fixed Assets that nobody wrote down, or written down that the
            company never paid for. Both are findings; neither is fixed by adjusting the register.
          </p>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="On the register" value={`${live.length}`} hint="Not counting disposals." />
        <Stat label="Book value" value={formatCents(reconciliation.registerBookValueCents)} />
        <Stat
          label="Depreciation owed"
          value={owedCents === 0 ? 'None' : formatCents(owedCents)}
          tone={owedMonths > 1 ? 'warning' : undefined}
          hint={
            owedMonths > 1
              ? `${owedMonths} months, oldest ${oldestOwed}. Each posts to its own month.`
              : undefined
          }
        />
      </div>

      {canPost && (
        <Card
          title="Run depreciation"
          subtitle="Charges every month that is owed, each dated to itself. Running it twice charges once."
        >
          {due.length === 0 ? (
            <Empty>Nothing is owed. Depreciation is up to date.</Empty>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Month</th>
                    <th className="px-4 py-2 font-medium">Asset</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {due.slice(0, 24).map((row) => (
                    <tr key={`${row.assetId}:${row.periodEnd}`} className="border-t border-line">
                      <td className="px-4 py-1.5 text-muted">{row.periodEnd}</td>
                      <td className="px-4 py-1.5">
                        {row.tag} · {row.name}
                      </td>
                      <td className="tnum px-4 py-1.5 text-right">{formatCents(row.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-line px-4 py-3">
                <p className="text-xs text-faint">
                  {due.length > 24 && `Showing 24 of ${due.length}. `}
                  {formatCents(owedCents)} across {owedMonths} {owedMonths === 1 ? 'month' : 'months'}.
                </p>
                <button
                  className="btn btn-primary"
                  disabled={pending}
                  onClick={() => act(() => runDepreciationAction(today))}
                >
                  Post it
                </button>
              </div>
            </>
          )}
        </Card>
      )}

      <Card title="The register" subtitle="Book value is cost less what was actually charged — never what the schedule expected.">
        {register.length === 0 ? (
          <Empty>Nothing on the register yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Tag</th>
                <th className="px-4 py-2 font-medium">Asset</th>
                <th className="px-4 py-2 font-medium">In service</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 text-right font-medium">Depreciated</th>
                <th className="px-4 py-2 text-right font-medium">Book value</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Paperwork</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {register.flatMap((asset) => [
                <tr key={asset.id} className="border-t border-line">
                  <td className="px-4 py-1.5 text-muted">{asset.tag}</td>
                  <td className="px-4 py-1.5">
                    {asset.name}
                    {asset.category && <span className="text-faint"> · {asset.category}</span>}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{asset.inServiceDate}</td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(asset.costCents)}</td>
                  <td className="tnum px-4 py-1.5 text-right text-muted">
                    {formatCents(asset.accumulatedCents)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right font-medium">
                    {formatCents(asset.bookValueCents)}
                  </td>
                  <td className="px-4 py-1.5 text-muted">
                    {ASSET_STATUS_LABELS[asset.status] ?? asset.status}
                    {asset.disposedOn && <span className="text-faint"> {asset.disposedOn}</span>}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <button
                      className={`btn btn-ghost text-xs ${
                        (evidence[asset.id]?.length ?? 0) === 0 ? 'text-faint' : ''
                      }`}
                      onClick={() =>
                        setShowingPaperwork(showingPaperwork === asset.id ? null : asset.id)
                      }
                    >
                      {evidence[asset.id]?.length
                        ? `${evidence[asset.id].length} file${
                            evidence[asset.id].length === 1 ? '' : 's'
                          }`
                        : 'none'}
                      {(notes[asset.id]?.filter((note) => note.isQuestion && !note.resolved)
                        .length ?? 0) > 0 && <span className="text-warning"> ?</span>}
                    </button>
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {canPost && asset.status !== 'disposed' && (
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={() => setDisposing(disposing === asset.id ? null : asset.id)}
                      >
                        Dispose
                      </button>
                    )}
                  </td>
                </tr>,
                showingPaperwork === asset.id ? (
                  <tr key={`${asset.id}-paperwork`} className="border-t border-line bg-raised/40">
                    <td colSpan={9} className="px-4 py-3">
                      <EvidencePanel
                        subjectType="fixed_asset"
                        subjectId={asset.id}
                        documents={evidence[asset.id] ?? []}
                        notes={notes[asset.id] ?? []}
                        canManage={canPost}
                        compact
                      />
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
        )}

        {disposing && canPost && (
          <DisposalForm
            asset={register.find((asset) => asset.id === disposing)!}
            banks={banks}
            today={today}
            act={act}
            pending={pending}
          />
        )}
      </Card>

      {canPost && (
        <Card
          title="Add an asset"
          subtitle="Registering posts nothing unless you say the purchase is not already in the books."
        >
          <button
            className="btn btn-ghost m-4 text-xs"
            onClick={() => setShowRegister((open) => !open)}
          >
            {showRegister ? 'Never mind' : 'Register one'}
          </button>
          {showRegister && (
            <RegisterForm banks={banks} today={today} act={act} pending={pending} />
          )}
        </Card>
      )}
    </div>
  )
}

function ReconRow({
  label,
  register,
  ledger,
  agrees,
}: {
  label: string
  register: number
  ledger: number
  agrees: boolean
}) {
  return (
    <tr className="border-t border-line">
      <td className="py-1.5">{label}</td>
      <td className="tnum py-1.5 text-right">{formatCents(register)}</td>
      <td className="tnum py-1.5 text-right">{formatCents(ledger)}</td>
      <td className={`tnum py-1.5 text-right ${agrees ? 'text-muted' : 'text-warning'}`}>
        {agrees ? '—' : formatCents(register - ledger)}
      </td>
    </tr>
  )
}

function RegisterForm({
  banks,
  today,
  act,
  pending,
}: {
  banks: Named[]
  today: string
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [cost, setCost] = useState('')
  const [salvage, setSalvage] = useState('')
  const [years, setYears] = useState('5')
  const [method, setMethod] = useState('straight_line')
  const [convention, setConvention] = useState('full_month')
  const [acquiredDate, setAcquiredDate] = useState(today)
  const [alreadyPosted, setAlreadyPosted] = useState(true)
  const [creditAccountId, setCreditAccountId] = useState(banks[0]?.id ?? '')

  const costCents = useMemo(() => parseAmountToCents(cost), [cost])
  const salvageCents = useMemo(() => (salvage ? parseAmountToCents(salvage) : 0), [salvage])
  const lifeMonths = Math.round((Number(years) || 0) * 12)

  // The monthly figure, shown before anything is saved. A five-year life on a
  // $48,000 van is $800 a month, and seeing that is what tells somebody the
  // life they typed is the one they meant.
  const monthlyCents =
    costCents !== null && lifeMonths > 0
      ? Math.round(((costCents ?? 0) - (salvageCents ?? 0)) / lifeMonths)
      : null

  return (
    <div className="space-y-3 border-t border-line px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="What is it">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ford Transit van"
            className="field"
          />
        </Field>
        <Field label="Category">
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Vehicles"
            className="field"
          />
        </Field>
        <Field label="Acquired">
          <input
            type="date"
            value={acquiredDate}
            onChange={(event) => setAcquiredDate(event.target.value)}
            className="field"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Cost">
          <input
            value={cost}
            onChange={(event) => setCost(event.target.value)}
            placeholder="48,000.00"
            className="field"
          />
        </Field>
        <Field label="Salvage value" hint="What it will be worth at the end. Often nothing.">
          <input
            value={salvage}
            onChange={(event) => setSalvage(event.target.value)}
            placeholder="0.00"
            className="field"
          />
        </Field>
        <Field label="Useful life (years)">
          <input
            value={years}
            onChange={(event) => setYears(event.target.value)}
            className="field"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Method" hint={METHOD_HINTS[method]}>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className="field"
          >
            {Object.entries(METHOD_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="First and last month" hint={CONVENTION_HINTS[convention]}>
          <select
            value={convention}
            onChange={(event) => setConvention(event.target.value)}
            className="field"
          >
            {Object.entries(CONVENTION_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {monthlyCents !== null && monthlyCents > 0 && (
        <p className="text-xs text-muted">
          Roughly <span className="tnum font-medium">{formatCents(monthlyCents)}</span> a month for{' '}
          {lifeMonths} months. The exact schedule is built when you save it, and the months add up
          to the cost to the cent.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={alreadyPosted}
          onChange={(event) => setAlreadyPosted(event.target.checked)}
        />
        The purchase is already in the books
      </label>

      {!alreadyPosted && (
        <Field label="Paid from" hint="Posts Dr Fixed Assets / Cr this account.">
          <select
            value={creditAccountId}
            onChange={(event) => setCreditAccountId(event.target.value)}
            className="field"
          >
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <button
        className="btn btn-primary"
        disabled={pending || !name.trim() || !costCents || lifeMonths < 1}
        onClick={() =>
          act(() =>
            registerAssetAction({
              name,
              category: category || undefined,
              costCents,
              salvageValueCents: salvageCents ?? 0,
              lifeMonths,
              method,
              convention,
              acquiredDate,
              postAcquisitionCreditAccountId: alreadyPosted ? undefined : creditAccountId,
            }),
          )
        }
      >
        Register it
      </button>
    </div>
  )
}

function DisposalForm({
  asset,
  banks,
  today,
  act,
  pending,
}: {
  asset: Asset
  banks: Named[]
  today: string
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
}) {
  const [disposedOn, setDisposedOn] = useState(today)
  const [proceeds, setProceeds] = useState('')
  const [accountId, setAccountId] = useState(banks[0]?.id ?? '')
  const [reason, setReason] = useState('')

  const proceedsCents = proceeds ? (parseAmountToCents(proceeds) ?? 0) : 0
  const projected = proceedsCents - asset.bookValueCents

  return (
    <div className="space-y-3 border-t border-line px-4 py-3">
      <p className="text-sm">
        Disposing of <span className="font-medium">{asset.tag} · {asset.name}</span>. Book value
        today is {formatCents(asset.bookValueCents)}
        {asset.depreciatedThrough && (
          <span className="text-faint"> (depreciated through {asset.depreciatedThrough})</span>
        )}
        .
      </p>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Disposed on">
          <input
            type="date"
            value={disposedOn}
            onChange={(event) => setDisposedOn(event.target.value)}
            className="field"
          />
        </Field>
        <Field label="Proceeds" hint="Leave empty if it was scrapped.">
          <input
            value={proceeds}
            onChange={(event) => setProceeds(event.target.value)}
            placeholder="0.00"
            className="field"
          />
        </Field>
        {proceedsCents > 0 && (
          <Field label="Into">
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className="field"
            >
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Why">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Sold to a courier firm"
            className="field"
          />
        </Field>
      </div>

      <p className="text-xs text-muted">
        {projected === 0
          ? 'That is exactly its book value, so neither a gain nor a loss.'
          : projected > 0
            ? `A gain of ${formatCents(projected)}, into Other income — not Sales Revenue, which would flatter a month that happened to sell a van.`
            : `A loss of ${formatCents(-projected)}, into Other expense.`}{' '}
        Any depreciation still owed is charged to its own months first, so the figure comes from the
        ledger rather than from the schedule.
      </p>

      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          act(() =>
            disposeAssetAction({
              assetId: asset.id,
              disposedOn,
              proceedsCents,
              proceedsAccountId: proceedsCents > 0 ? accountId : undefined,
              reason: reason || undefined,
            }),
          )
        }
      >
        Take it off the books
      </button>
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
  tone?: 'warning'
}) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`tnum mt-1 text-xl font-semibold ${tone === 'warning' ? 'text-warning' : ''}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block text-xs text-muted">
      <span className="mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-faint">{hint}</span>}
    </label>
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
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}
