'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  closeFundAction,
  createFundAction,
  receivePledgeAction,
  recordContributionAction,
  runReleasesAction,
  type ActionResult,
} from '@/app/actions/funds'

type Named = { id: string; name: string }

type FundBalance = {
  fundId: string
  code: string
  name: string
  restriction: 'unrestricted' | 'restricted' | 'perpetual'
  netAssetClass: 'without_donor_restrictions' | 'with_donor_restrictions'
  purpose: string | null
  expiresOn: string | null
  receivedCents: number
  spentCents: number
  releasedCents: number
  availableCents: number
  unreleasedCents: number
  shortfallCents: number
}

type Props = {
  month: string
  balances: FundBalance[]
  netAssets: {
    asOf: string
    withoutRestrictionCents: number
    withRestrictionCents: number
    totalCents: number
    contributionRevenueCents: number
    untaggedContributionCents: number
    agrees: boolean
    overspent: FundBalance[]
    unreleasedCents: number
  } | null
  preview: {
    periodStart: string
    periodEnd: string
    lines: Array<{
      fundId: string
      fundCode: string
      fundName: string
      spentCents: number
      releasedCents: number
      shortfallCents: number
      skipped: 'already_released' | 'nothing_spent' | 'nothing_to_release' | null
    }>
    releasedCents: number
    shortfallCents: number
  }
  pledges: Array<{
    id: string
    fundCode: string
    fundName: string
    donorName: string | null
    receivedOn: string
    amountCents: number
    receivedCents: number
    outstandingCents: number
  }>
  contributions: Array<{
    id: string
    fundCode: string
    fundName: string
    donorName: string | null
    kind: 'gift' | 'pledge'
    receivedOn: string
    amountCents: number
    outstandingCents: number
    memo: string | null
  }>
  donors: Named[]
  accounts: Named[]
  donorWord: string
  canManage: boolean
}

const RESTRICTION_WORDS: Record<FundBalance['restriction'], string> = {
  unrestricted: 'unrestricted',
  restricted: 'restricted',
  perpetual: 'endowment — principal never spendable',
}

/**
 * The funds workspace (spec §5 Nonprofit, Phase 26).
 *
 * Opens on what each fund still has rather than on a list of funds, because
 * the question a trustee opens this to answer is "can we afford it, and out of
 * which pot" — and a list of names answers neither.
 */
export function FundsBoard(props: Props) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [tab, setTab] = useState<'balances' | 'release' | 'money'>('balances')
  const [showNewFund, setShowNewFund] = useState(false)

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

  const restricted = props.balances.filter(
    (fund) => fund.netAssetClass === 'with_donor_restrictions',
  )
  const restrictedCents = restricted.reduce((sum, fund) => sum + fund.availableCents, 0)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Funds</h2>
        <p className="text-sm text-muted">
          {props.balances.length} fund{props.balances.length === 1 ? '' : 's'} ·{' '}
          <span className={restrictedCents > 0 ? 'text-warning' : 'text-muted'}>
            {formatCents(restrictedCents)} still restricted
          </span>
          {props.netAssets && props.netAssets.unreleasedCents > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="text-warning">
                {formatCents(props.netAssets.unreleasedCents)} spent but not yet released
              </span>
            </>
          )}
        </p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {(
            [
              ['balances', 'What each fund has'],
              ['release', 'Release run'],
              ['money', `${props.donorWord}s and promises`],
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
              onClick={() => setShowNewFund((was) => !was)}
            >
              {showNewFund ? 'Never mind' : 'Open a fund'}
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

      {showNewFund && props.canManage && (
        <NewFund act={act} pending={pending} onDone={() => setShowNewFund(false)} />
      )}

      {tab === 'balances' && <Balances {...props} act={act} pending={pending} />}
      {tab === 'release' && <ReleaseRun {...props} act={act} pending={pending} />}
      {tab === 'money' && <Money {...props} act={act} pending={pending} />}
    </div>
  )
}

type Helpers = { act: (fn: () => Promise<ActionResult>) => void; pending: boolean }

function Balances({ balances, netAssets, canManage, act, pending }: Props & Helpers) {
  return (
    <div className="space-y-4">
      {netAssets && (
        <div className="card px-4 py-3">
          <h3 className="text-sm font-semibold">Net assets</h3>
          <p className="mt-1 text-xs text-muted">
            The two columns a charity reports. Assets less liabilities, split by what donors said
            — not read off the equity accounts, which mid-year still hold last year&rsquo;s
            close.
          </p>

          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-faint">Without donor restrictions</dt>
              <dd className="text-lg tabular-nums">
                {formatCents(netAssets.withoutRestrictionCents)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">With donor restrictions</dt>
              <dd className="text-lg tabular-nums text-warning">
                {formatCents(netAssets.withRestrictionCents)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Total</dt>
              <dd className="text-lg tabular-nums">{formatCents(netAssets.totalCents)}</dd>
            </div>
          </dl>

          {/* The honest check. Not "does this page add up to itself" — it does,
              by construction — but "is there money on the books this page
              cannot account for". */}
          <p className="mt-3 border-t border-line pt-3 text-xs">
            {netAssets.agrees ? (
              <span className="text-success">
                Every donation on the books belongs to a named fund.
              </span>
            ) : (
              <span className="text-warning">
                {formatCents(netAssets.untaggedContributionCents)} of donations carry no fund, so
                they are outside every figure above. Tag them on the journal entry, or open a
                general fund for them.
              </span>
            )}
          </p>

          {netAssets.overspent.length > 0 && (
            <p className="mt-2 text-xs text-danger">
              {netAssets.overspent.length} fund
              {netAssets.overspent.length === 1 ? ' has' : 's have'} been spent beyond what was
              given for {netAssets.overspent.length === 1 ? 'it' : 'them'}:{' '}
              {netAssets.overspent.map((fund) => fund.code).join(', ')}. That money came out of
              general funds.
            </p>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Fund</th>
              <th className="px-4 py-2">Given</th>
              <th className="px-4 py-2">Spent</th>
              <th className="px-4 py-2">Released</th>
              <th className="px-4 py-2">Still has</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {balances.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={6}>
                  No funds yet. Open one to start tracking what money was given for.
                </td>
              </tr>
            )}
            {balances.map((fund) => (
              <tr key={fund.fundId}>
                <td className="px-4 py-2">
                  <span className="font-medium">{fund.name}</span>
                  <span className="block text-xs text-faint">
                    {fund.code} · {RESTRICTION_WORDS[fund.restriction]}
                    {fund.purpose && ` · ${fund.purpose}`}
                  </span>
                </td>
                <td className="px-4 py-2 tabular-nums">{formatCents(fund.receivedCents)}</td>
                <td className="px-4 py-2 tabular-nums">{formatCents(fund.spentCents)}</td>
                <td className="px-4 py-2 tabular-nums">
                  {formatCents(fund.releasedCents)}
                  {fund.unreleasedCents > 0 && (
                    <span className="block text-xs text-warning">
                      {formatCents(fund.unreleasedCents)} earned, not run
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {formatCents(fund.availableCents)}
                  {fund.shortfallCents > 0 && (
                    <span className="block text-xs text-danger">
                      {formatCents(fund.shortfallCents)} overspent
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {canManage && (
                    <button
                      className="btn btn-ghost text-xs"
                      disabled={pending}
                      onClick={() => act(() => closeFundAction(fund.fundId))}
                    >
                      Close
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-faint">
        What each fund spent comes from the ledger, not from this screen — a bill coded to a fund
        by somebody who has never opened this page counts, and earns its release. For the detail,
        see{' '}
        <a className="text-brand hover:underline" href="/accounting/dimensions">
          profit and loss by Fund
        </a>
        .
      </p>
    </div>
  )
}

function ReleaseRun({ month, preview, canManage, act, pending }: Props & Helpers) {
  const postable = preview.lines.filter((line) => line.skipped === null)

  return (
    <div className="space-y-4">
      <div className="card px-4 py-3">
        <h3 className="text-sm font-semibold">
          Release restriction for {preview.periodStart.slice(0, 7)}
        </h3>
        <p className="mt-1 text-xs text-muted">
          Spending against a restricted fund satisfies the donor&rsquo;s condition for that much
          of it. The release moves the money from the restricted column to the unrestricted one
          and <strong>changes no total</strong> — the debit and the credit are both income
          accounts and they sum to zero.
        </p>

        <form className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="block text-faint">Month</span>
            <input
              className="field w-40"
              type="month"
              defaultValue={month.slice(0, 7)}
              onChange={(event) => {
                const value = event.target.value
                if (value) window.location.search = `?month=${value}-01`
              }}
            />
          </label>

          {canManage && (
            <button
              className="btn"
              type="button"
              disabled={pending || postable.length === 0}
              onClick={() => act(() => runReleasesAction({ month: preview.periodStart }))}
            >
              Release {formatCents(preview.releasedCents)}
            </button>
          )}
        </form>

        {postable.length === 0 && (
          <p className="mt-2 text-xs text-muted">
            Nothing to release this month — every fund with spending has already had its
            restriction released.
          </p>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Fund</th>
              <th className="px-4 py-2">Spent this month</th>
              <th className="px-4 py-2">Would release</th>
              <th className="px-4 py-2">Beyond the fund</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {preview.lines.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={4}>
                  No restricted funds. An endowment never releases its principal, and
                  unrestricted money has nothing to release.
                </td>
              </tr>
            )}
            {preview.lines.map((line) => (
              <tr key={line.fundId}>
                <td className="px-4 py-2">
                  <span className="font-medium">{line.fundName}</span>
                  <span className="block text-xs text-faint">{line.fundCode}</span>
                </td>
                <td className="px-4 py-2 tabular-nums">{formatCents(line.spentCents)}</td>
                <td className="px-4 py-2 tabular-nums">
                  {line.skipped === 'already_released' ? (
                    <span className="text-xs text-muted">already released</span>
                  ) : line.skipped === 'nothing_spent' ? (
                    <span className="text-xs text-faint">nothing spent</span>
                  ) : line.skipped === 'nothing_to_release' ? (
                    <span className="text-xs text-warning">nothing left to release</span>
                  ) : (
                    formatCents(line.releasedCents)
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {line.shortfallCents > 0 ? (
                    <span className="text-danger">{formatCents(line.shortfallCents)}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.shortfallCents > 0 && (
        <p className="text-xs text-danger">
          {formatCents(preview.shortfallCents)} was spent beyond what those funds hold. The
          release covers what it can; the rest came out of general money and stays visible here
          rather than being quietly absorbed.
        </p>
      )}
    </div>
  )
}

function Money({
  balances,
  pledges,
  contributions,
  donors,
  accounts,
  donorWord,
  canManage,
  act,
  pending,
}: Props & Helpers) {
  const [kind, setKind] = useState<'gift' | 'pledge'>('gift')

  return (
    <div className="space-y-4">
      {canManage && (
        <form
          className="card space-y-3 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            const amount = Math.round(Number(form.get('amount')) * 100)
            act(() =>
              recordContributionAction({
                fundId: String(form.get('fundId')),
                donorId: String(form.get('donorId')) || null,
                kind,
                source: String(form.get('source')) as 'donation' | 'grant',
                receivedOn: String(form.get('receivedOn')),
                amountCents: amount,
                financialAccountId: kind === 'gift' ? String(form.get('accountId')) : null,
                reference: String(form.get('reference') ?? ''),
              }),
            )
            event.currentTarget.reset()
          }}
        >
          <h3 className="text-sm font-semibold">Record money in</h3>

          <div className="flex gap-1.5">
            {(
              [
                ['gift', 'It has arrived'],
                ['pledge', 'It was promised'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`chip px-3 py-1 text-xs ${
                  kind === key ? 'bg-brand text-brand-ink' : 'bg-raised text-muted'
                }`}
                onClick={() => setKind(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {kind === 'pledge' && (
            <p className="text-xs text-warning">
              A promise is income the day it is made, not the day the cheque clears. This posts
              it to Pledges Receivable now; receiving it later clears the receivable and posts no
              income at all.
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-xs">
              <span className="block text-faint">Fund</span>
              <select className="field" name="fundId" required>
                {balances.map((fund) => (
                  <option key={fund.fundId} value={fund.fundId}>
                    {fund.code} — {fund.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs">
              <span className="block text-faint">{donorWord}</span>
              <select className="field" name="donorId">
                <option value="">Anonymous</option>
                {donors.map((donor) => (
                  <option key={donor.id} value={donor.id}>
                    {donor.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs">
              <span className="block text-faint">Kind</span>
              <select className="field" name="source" defaultValue="donation">
                <option value="donation">Donation</option>
                <option value="grant">Grant</option>
              </select>
            </label>

            <label className="text-xs">
              <span className="block text-faint">Date</span>
              <input className="field" type="date" name="receivedOn" required />
            </label>

            <label className="text-xs">
              <span className="block text-faint">Amount</span>
              <input className="field" type="number" step="0.01" name="amount" required />
            </label>

            {kind === 'gift' && (
              <label className="text-xs">
                <span className="block text-faint">Into</span>
                <select className="field" name="accountId" required>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="text-xs">
              <span className="block text-faint">Reference</span>
              <input className="field" name="reference" placeholder="Optional" />
            </label>
          </div>

          <button className="btn text-sm" type="submit" disabled={pending}>
            {kind === 'pledge' ? 'Record the promise' : 'Record the gift'}
          </button>
        </form>
      )}

      {pledges.length > 0 && (
        <div className="card overflow-hidden">
          <h3 className="px-4 py-3 text-sm font-semibold">
            Promised, not yet received
            <span className="ml-2 text-xs font-normal text-muted">
              already counted as income — this is the money still to collect
            </span>
          </h3>
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="px-4 py-2">{donorWord}</th>
                <th className="px-4 py-2">Fund</th>
                <th className="px-4 py-2">Promised</th>
                <th className="px-4 py-2">Outstanding</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pledges.map((pledge) => (
                <tr key={pledge.id}>
                  <td className="px-4 py-2">{pledge.donorName ?? 'Anonymous'}</td>
                  <td className="px-4 py-2 text-xs text-faint">
                    {pledge.fundCode} · {pledge.receivedOn}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{formatCents(pledge.amountCents)}</td>
                  <td className="px-4 py-2 tabular-nums text-warning">
                    {formatCents(pledge.outstandingCents)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canManage && accounts.length > 0 && (
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() =>
                            receivePledgeAction({
                              contributionId: pledge.id,
                              amountCents: pledge.outstandingCents,
                              receivedOn: new Date().toISOString().slice(0, 10),
                              financialAccountId: accounts[0].id,
                            }),
                          )
                        }
                      >
                        It arrived
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card overflow-hidden">
        <h3 className="px-4 py-3 text-sm font-semibold">Recent money in</h3>
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">{donorWord}</th>
              <th className="px-4 py-2">Fund</th>
              <th className="px-4 py-2">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {contributions.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={4}>
                  Nothing recorded yet.
                </td>
              </tr>
            )}
            {contributions.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-2 tabular-nums text-xs">{row.receivedOn}</td>
                <td className="px-4 py-2">
                  {row.donorName ?? 'Anonymous'}
                  {row.kind === 'pledge' && (
                    <span className="ml-2 chip bg-raised px-2 py-0.5 text-[10px] text-muted">
                      promise
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-faint">{row.fundCode}</td>
                <td className="px-4 py-2 tabular-nums">{formatCents(row.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function NewFund({
  act,
  pending,
  onDone,
}: Helpers & { onDone: () => void }) {
  return (
    <form
      className="card space-y-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        act(() =>
          createFundAction({
            code: String(form.get('code')),
            name: String(form.get('name')),
            restriction: String(form.get('restriction')) as 'restricted',
            purpose: String(form.get('purpose') ?? ''),
          }),
        )
        onDone()
      }}
    >
      <h3 className="text-sm font-semibold">Open a fund</h3>
      <p className="text-xs text-muted">
        What the donor said it is for, in their words. The restriction cannot be edited
        afterwards — a gift given for the roof does not become a gift for anything else because
        somebody changed a dropdown.
      </p>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="block text-faint">Code</span>
          <input className="field" name="code" placeholder="ROOF" required />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="block text-faint">Name</span>
          <input className="field" name="name" placeholder="Roof appeal" required />
        </label>
        <label className="text-xs">
          <span className="block text-faint">Restriction</span>
          <select className="field" name="restriction" defaultValue="restricted">
            <option value="restricted">Restricted</option>
            <option value="unrestricted">Unrestricted</option>
            <option value="perpetual">Endowment</option>
          </select>
        </label>
        <label className="text-xs sm:col-span-4">
          <span className="block text-faint">What it is for</span>
          <input
            className="field"
            name="purpose"
            placeholder="Replacing the hall roof, as set out in the appeal letter."
          />
        </label>
      </div>

      <button className="btn text-sm" type="submit" disabled={pending}>
        Open it
      </button>
    </form>
  )
}
