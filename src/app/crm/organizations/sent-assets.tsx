'use client'

import { useState, useTransition } from 'react'
import {
  associateAssetAction,
  disassociateAssetAction,
  sentAssetsAction,
} from '@/app/actions/studio'

/**
 * What we have sent this client (Phase 180, spec §8).
 *
 * §8's last bullet gained a table and five composite keys; this is the reader
 * that makes it a capability rather than a column. Mounted on the organisation
 * row because that is where the question gets asked — somebody about to send a
 * capability statement, wondering whether they already did.
 *
 * Collapsed until opened, and the count is on the summary. A panel that fetched
 * the list for every organisation on the page would make the page slower for
 * everybody to answer a question about one of them; the count comes from the
 * one grouped query the page already runs.
 */

export type SentAsset = {
  linkId: string
  assetId: string
  filename: string
  note: string | null
}

export function SentAssets({
  organizationId,
  count,
  assets,
  canManage,
}: {
  organizationId: string
  /** From the page's grouped count, so the summary needs no fetch. */
  count: number
  /** The company's assets, for the picker. */
  assets: Array<{ id: string; filename: string }>
  canManage: boolean
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<SentAsset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [choice, setChoice] = useState('')
  const [note, setNote] = useState('')

  function load() {
    startTransition(async () => {
      const result = await sentAssetsAction(organizationId)
      if (result.ok) setRows(result.assets)
      else setError(result.error)
    })
  }

  function toggle() {
    const next = !open
    setOpen(next)
    // Fetched on first open and kept, because the common act is opening one
    // record, reading it, and closing it again.
    if (next && rows === null) load()
  }

  function attach() {
    if (!choice) return
    setError(null)
    startTransition(async () => {
      const result = await associateAssetAction({
        assetId: choice,
        kind: 'organization',
        subjectId: organizationId,
        note,
      })
      if (!result.ok) setError(result.error)
      else {
        setChoice('')
        setNote('')
        load()
      }
    })
  }

  function detach(linkId: string) {
    setError(null)
    startTransition(async () => {
      const result = await disassociateAssetAction(linkId)
      if (!result.ok) setError(result.error)
      else load()
    })
  }

  // Already sent, so not offered again — the unique index would refuse it and
  // a picker that offers a choice the database rejects is a worse way to say so.
  const sentIds = new Set((rows ?? []).map((row) => row.assetId))
  const available = assets.filter((asset) => !sentIds.has(asset.id))

  return (
    <div className="mt-2">
      <button
        onClick={toggle}
        className="text-xs text-muted underline-offset-2 hover:underline"
        disabled={pending}
      >
        {count === 0
          ? 'Nothing sent yet'
          : count === 1
            ? '1 thing sent'
            : `${count} things sent`}
        {open ? ' ▴' : ' ▾'}
      </button>

      {open && (
        <div className="mt-2 rounded border border-line bg-raised px-3 py-2">
          {error && <p className="mb-2 text-xs text-danger">{error}</p>}

          {rows === null ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted">
              No collateral is associated with this record yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {rows.map((row) => (
                <li key={row.linkId} className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="font-medium">{row.filename}</span>
                  {row.note && <span className="text-muted">— {row.note}</span>}
                  {canManage && (
                    <button
                      onClick={() => detach(row.linkId)}
                      className="text-faint underline-offset-2 hover:underline"
                      disabled={pending}
                    >
                      remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canManage && available.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="field py-1 text-xs"
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
              >
                <option value="">Associate an asset…</option>
                {available.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.filename}
                  </option>
                ))}
              </select>
              <input
                className="input input-sm text-xs"
                placeholder="Why, if it is not obvious"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <button className="btn btn-sm" onClick={attach} disabled={pending || !choice}>
                Associate
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
