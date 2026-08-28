'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  correctEntryAction,
  entryDetailAction,
  type ActionResult,
} from '@/app/actions/accounting'
import type { CorrectionVerdict } from '@/modules/ledger/corrections'
import { formatCents } from '@/lib/money'

type Row = {
  id: string
  entryNumber: number
  entryDate: string
  memo: string | null
  source: string
  status: 'posted' | 'void'
  reversalOfId: string | null
  reversedBy: number | null
  correction: CorrectionVerdict
}

type Line = {
  id: string
  accountNumber: string
  accountName: string
  debitCents: number
  creditCents: number
  memo: string | null
}

/**
 * The journal, readable and correctable (Phase 51).
 *
 * The header on this screen has always said *"the ledger corrects by reversal,
 * never by deletion"* — and the screen offered neither correction, and showed
 * no debits or credits at all. `voidEntry`, `reverseEntry` and `entryWithLines`
 * had all existed since Phase 2 with no caller here.
 */
export function JournalEntries({ rows, canPost }: { rows: Row[]; canPost: boolean }) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const [openId, setOpenId] = useState<string | null>(null)
  const [lines, setLines] = useState<Record<string, Line[]>>({})
  const [memo, setMemo] = useState('')

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error },
      )
      if (result.ok) {
        setOpenId(null)
        setMemo('')
        router.refresh()
      }
    })
  }

  /**
   * Lines are fetched when a row is opened rather than sent with the page.
   *
   * A hundred entries of half a dozen lines each is a lot of money nobody
   * asked to see, and the answer to "what does entry #412 actually say" is
   * wanted one entry at a time.
   */
  function toggle(id: string) {
    setNotice(null)
    if (openId === id) {
      setOpenId(null)
      return
    }

    setOpenId(id)
    if (lines[id]) return

    startTransition(async () => {
      const result = await entryDetailAction(id)
      if (!result.ok) {
        setNotice({ ok: false, text: result.error })
        return
      }
      setLines((current) => ({ ...current, [id]: result.detail.lines }))
    })
  }

  return (
    <section className="card mt-4 overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Journal entries</h2>
        <p className="text-xs text-muted">
          Most entries are derived from bank transactions, invoices, and payments. Voided entries
          stay listed — the ledger corrects by reversal, never by deletion.{' '}
          <span className="text-faint">Open one to see what it says.</span>
        </p>
      </header>

      {notice && (
        <p
          className={`border-b border-line px-4 py-3 text-sm ${
            notice.ok ? 'text-success' : 'text-danger'
          }`}
          role="status"
        >
          {notice.text}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No entries yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Memo</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = openId === row.id
                const detail = lines[row.id]
                const debits = detail?.reduce((sum, line) => sum + line.debitCents, 0) ?? 0

                return (
                  // Keyed on the fragment, not on the rows inside it: a row and
                  // its detail are two <tr>s for one entry, and React wants the
                  // key where the list element actually is.
                  <Fragment key={row.id}>
                    <tr
                      className={`border-t border-line ${row.status === 'void' ? 'text-faint' : ''}`}
                    >
                      <td className="tnum px-4 py-1.5 text-faint">{row.entryNumber}</td>
                      <td className="tnum whitespace-nowrap px-4 py-1.5">{row.entryDate}</td>
                      <td className={`px-4 py-1.5 ${row.status === 'void' ? 'line-through' : ''}`}>
                        {row.memo ?? '—'}
                        {/* Both halves of a correction point at each other, so
                            neither can be read as the whole story on its own. */}
                        {row.reversedBy && (
                          <span className="block text-xs text-faint">
                            reversed by #{row.reversedBy}
                          </span>
                        )}
                        {row.reversalOfId && (
                          <span className="block text-xs text-faint">a reversal</span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-xs text-muted">
                        {row.source.replace('_', ' ')}
                      </td>
                      <td className="px-4 py-1.5">
                        <span
                          className={`chip ${
                            row.status === 'posted'
                              ? 'bg-positive/15 text-positive'
                              : 'bg-raised text-faint'
                          }`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-1.5 text-right">
                        <button className="btn btn-ghost text-xs" onClick={() => toggle(row.id)}>
                          {open ? 'Close' : 'Open'}
                        </button>
                      </td>
                    </tr>

                    {open && (
                      <tr className="border-t border-line bg-raised/40">
                        <td colSpan={6} className="px-4 py-3">
                          {!detail ? (
                            <p className="text-xs text-muted">Reading it…</p>
                          ) : (
                            <>
                              <table className="w-full text-sm">
                                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                                  <tr>
                                    <th className="py-1 font-medium">Account</th>
                                    <th className="py-1 font-medium">Memo</th>
                                    <th className="py-1 text-right font-medium">Debit</th>
                                    <th className="py-1 text-right font-medium">Credit</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detail.map((line) => (
                                    <tr key={line.id} className="border-t border-line/60">
                                      <td className="py-1">
                                        <span className="tnum text-faint">{line.accountNumber}</span>{' '}
                                        {line.accountName}
                                      </td>
                                      <td className="py-1 text-xs text-muted">{line.memo ?? '—'}</td>
                                      <td className="tnum py-1 text-right">
                                        {line.debitCents ? formatCents(line.debitCents) : ''}
                                      </td>
                                      <td className="tnum py-1 text-right">
                                        {line.creditCents ? formatCents(line.creditCents) : ''}
                                      </td>
                                    </tr>
                                  ))}
                                  <tr className="border-t border-line font-medium">
                                    <td className="py-1" colSpan={2}>
                                      {/* Shown once, not twice. Debits equal
                                          credits by construction, and printing
                                          the same number in two columns invites
                                          somebody to check whether it agrees. */}
                                      Balanced
                                    </td>
                                    <td className="tnum py-1 text-right">{formatCents(debits)}</td>
                                    <td className="tnum py-1 text-right">{formatCents(debits)}</td>
                                  </tr>
                                </tbody>
                              </table>

                              {canPost && (
                                <div className="mt-3 border-t border-line pt-3">
                                  {row.correction.ok ? (
                                    <div className="flex flex-wrap items-end gap-2">
                                      <p className="w-full text-xs text-muted">
                                        {row.correction.why}
                                      </p>
                                      <label className="text-xs text-muted">
                                        <span className="mb-1 block">Why</span>
                                        <input
                                          value={memo}
                                          onChange={(event) => setMemo(event.target.value)}
                                          placeholder="Coded to the wrong account"
                                          className="field w-64 py-1.5 text-sm"
                                        />
                                      </label>
                                      {row.correction.method === 'void' ? (
                                        <>
                                          <button
                                            className="btn btn-ghost text-sm text-danger"
                                            disabled={pending}
                                            onClick={() =>
                                              act(() =>
                                                correctEntryAction({
                                                  entryId: row.id,
                                                  method: 'void',
                                                  memo,
                                                }),
                                              )
                                            }
                                          >
                                            Void it
                                          </button>
                                          {/* Offered alongside, because an open
                                              period is not proof nobody has
                                              reported on it. */}
                                          <button
                                            className="btn btn-ghost text-sm"
                                            disabled={pending}
                                            onClick={() =>
                                              act(() =>
                                                correctEntryAction({
                                                  entryId: row.id,
                                                  method: 'reverse',
                                                  memo,
                                                }),
                                              )
                                            }
                                          >
                                            Reverse it instead
                                          </button>
                                        </>
                                      ) : (
                                        <button
                                          className="btn btn-ghost text-sm"
                                          disabled={pending}
                                          onClick={() =>
                                            act(() =>
                                              correctEntryAction({
                                                entryId: row.id,
                                                method: 'reverse',
                                                memo,
                                              }),
                                            )
                                          }
                                        >
                                          Reverse it
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    /* The refusal says what to do instead, not
                                       just that the answer is no (Phase 47's
                                       rule, applied to the ledger). */
                                    <p className="text-xs text-muted">{row.correction.why}</p>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
