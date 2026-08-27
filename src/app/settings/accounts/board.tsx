'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  createAccountAction,
  renameAccountAction,
  setAccountActiveAction,
  type ActionResult,
} from '@/app/actions/accounts'
import { formatCents } from '@/lib/money'

type TieOut = {
  ledgerCents: number
  feedCents: number
  differenceCents: number
  uncategorizedCount: number
}

type Account = {
  id: string
  name: string
  kind: string
  mask: string | null
  currency: string
  isActive: boolean
  bankConnectionId: string | null
  chartAccountNumber: string
  chartAccountName: string
  transactionCount: number
  tieOut: TieOut | null
}

const KINDS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'checking', label: 'Current account', hint: 'The account the business trades through.' },
  { value: 'savings', label: 'Deposit account', hint: 'Money set aside.' },
  { value: 'credit_card', label: 'Credit card', hint: 'A card, so a liability rather than an asset.' },
  { value: 'loan', label: 'Loan', hint: 'A facility being drawn down or repaid.' },
  { value: 'cash', label: 'Cash', hint: 'A till or a petty cash box.' },
  { value: 'other', label: 'Something else', hint: 'Treated as an asset until you say otherwise.' },
]

const KIND_LABELS: Record<string, string> = Object.fromEntries(
  KINDS.map((kind) => [kind.value, kind.label]),
)

/**
 * Opening, renaming and closing bank accounts.
 *
 * The ledger account is shown on every row rather than hidden, because it is
 * the thing that makes the balance sheet readable — and because the whole
 * point of this phase is that each account has one of its own.
 */
export function AccountsBoard({
  accounts,
  canManage,
}: {
  accounts: Account[]
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [kind, setKind] = useState('checking')
  const [mask, setMask] = useState('')

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

  function add() {
    act(() => createAccountAction({ name, kind, mask }), () => {
      setName('')
      setMask('')
      setAdding(false)
    })
  }

  const open = accounts.filter((account) => account.isActive)
  const closed = accounts.filter((account) => !account.isActive)
  const selectedKind = KINDS.find((entry) => entry.value === kind)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Bank accounts</h2>
        <p className="text-sm text-muted">
          Every account the business banks through, and the line on the balance sheet each one
          posts to.{' '}
          <span className="text-faint">
            One account, one ledger account — two sharing a line means the balance sheet cannot
            say what either holds.
          </span>
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          <p className="whitespace-pre-line">{notice.text}</p>
        </div>
      )}

      {accounts.length === 0 && (
        <section className="card px-4 py-8 text-center">
          <p className="text-sm font-medium">No accounts yet.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Add the account your business banks through. Once it exists you can import a statement
            into it, reconcile it, and record deposits against it.
          </p>
        </section>
      )}

      {canManage && (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">Add an account</h3>
              <p className="text-xs text-muted">
                A ledger account is made for it automatically — you do not have to pick one.
              </p>
            </div>
            {!adding && (
              <button className="btn btn-primary text-sm" onClick={() => setAdding(true)}>
                Add an account
              </button>
            )}
          </header>

          {adding && (
            <div className="space-y-3 px-4 py-3">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-muted">
                  <span className="mb-1 block">What you call it</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Business Current Account"
                    className="field py-1.5 text-sm"
                    autoFocus
                  />
                </label>

                <label className="text-xs text-muted">
                  <span className="mb-1 block">What kind</span>
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                    className="field py-1.5 text-sm"
                  >
                    {KINDS.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs text-muted">
                  <span className="mb-1 block">Last four digits</span>
                  <input
                    value={mask}
                    onChange={(event) => setMask(event.target.value)}
                    placeholder="4471"
                    inputMode="numeric"
                    maxLength={4}
                    className="field w-24 py-1.5 text-sm"
                  />
                </label>
              </div>

              <p className="text-xs text-faint">
                {selectedKind?.hint} Only the last four digits are kept — never the full account
                number.
              </p>

              <div className="flex items-center gap-2">
                <button
                  className="btn btn-primary"
                  disabled={pending || !name.trim()}
                  onClick={add}
                >
                  Add it
                </button>
                <button className="btn btn-ghost" disabled={pending} onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {open.length > 0 && (
        <AccountTable
          title="Open"
          accounts={open}
          canManage={canManage}
          pending={pending}
          renaming={renaming}
          setRenaming={setRenaming}
          act={act}
        />
      )}

      {closed.length > 0 && (
        <AccountTable
          title="Closed"
          subtitle="Nothing was deleted. Every transaction and reconciliation is still here."
          accounts={closed}
          canManage={canManage}
          pending={pending}
          renaming={renaming}
          setRenaming={setRenaming}
          act={act}
        />
      )}

      {accounts.length > 0 && (
        <p className="text-xs text-faint">
          Ready to bring transactions in?{' '}
          <Link className="underline" href="/settings/import">
            Import a bank statement
          </Link>
          .
        </p>
      )}
    </div>
  )
}

function AccountTable({
  title,
  subtitle,
  accounts,
  canManage,
  pending,
  renaming,
  setRenaming,
  act,
}: {
  title: string
  subtitle?: string
  accounts: Account[]
  canManage: boolean
  pending: boolean
  renaming: string | null
  setRenaming: (id: string | null) => void
  act: (fn: () => Promise<ActionResult>, onOk?: () => void) => void
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Account</th>
              <th className="px-4 py-2 font-medium">Kind</th>
              <th className="px-4 py-2 font-medium">Posts to</th>
              <th className="px-4 py-2 text-right font-medium">In the ledger</th>
              <th className="px-4 py-2 text-right font-medium">Feed</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                canManage={canManage}
                pending={pending}
                isRenaming={renaming === account.id}
                setRenaming={setRenaming}
                act={act}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AccountRow({
  account,
  canManage,
  pending,
  isRenaming,
  setRenaming,
  act,
}: {
  account: Account
  canManage: boolean
  pending: boolean
  isRenaming: boolean
  setRenaming: (id: string | null) => void
  act: (fn: () => Promise<ActionResult>, onOk?: () => void) => void
}) {
  const [draft, setDraft] = useState(account.name)
  const [draftMask, setDraftMask] = useState(account.mask ?? '')

  return (
    <tr className="border-t border-line align-top">
      <td className="px-4 py-2">
        {isRenaming ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="field py-1 text-sm"
              autoFocus
            />
            <input
              value={draftMask}
              onChange={(event) => setDraftMask(event.target.value)}
              placeholder="4471"
              inputMode="numeric"
              maxLength={4}
              className="field w-20 py-1 text-sm"
            />
            <button
              className="btn btn-primary text-xs"
              disabled={pending || !draft.trim()}
              onClick={() =>
                act(
                  () => renameAccountAction({ id: account.id, name: draft, mask: draftMask }),
                  () => setRenaming(null),
                )
              }
            >
              Save
            </button>
            <button className="btn btn-ghost text-xs" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span className="font-medium">{account.name}</span>
            {account.mask && <span className="ml-1 text-muted">••{account.mask}</span>}
            <span className="block text-xs text-faint">
              {account.transactionCount === 0
                ? 'No transactions yet'
                : `${account.transactionCount} transaction${account.transactionCount === 1 ? '' : 's'}`}
              {account.bankConnectionId ? ' · connected' : ' · added by hand'}
            </span>
          </>
        )}
      </td>
      <td className="px-4 py-2 text-muted">{KIND_LABELS[account.kind] ?? account.kind}</td>
      <td className="px-4 py-2">
        <span className="tnum">{account.chartAccountNumber}</span>{' '}
        <span className="text-muted">{account.chartAccountName}</span>
      </td>
      <td className="tnum px-4 py-2 text-right">
        {account.tieOut ? formatCents(account.tieOut.ledgerCents) : '—'}
      </td>
      <td className="tnum px-4 py-2 text-right">
        {account.tieOut ? (
          <>
            {formatCents(account.tieOut.feedCents)}
            {account.tieOut.uncategorizedCount > 0 && (
              <span className="block text-xs font-normal text-muted">
                {account.tieOut.uncategorizedCount} still in the inbox
              </span>
            )}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-right">
        {canManage && !isRenaming && (
          <>
            <button
              className="btn btn-ghost text-xs"
              disabled={pending}
              onClick={() => {
                setDraft(account.name)
                setDraftMask(account.mask ?? '')
                setRenaming(account.id)
              }}
            >
              Rename
            </button>
            <button
              className="btn btn-ghost text-xs"
              disabled={pending}
              onClick={() =>
                act(() => setAccountActiveAction({ id: account.id, isActive: !account.isActive }))
              }
            >
              {account.isActive ? 'Close' : 'Reopen'}
            </button>
          </>
        )}
      </td>
    </tr>
  )
}
