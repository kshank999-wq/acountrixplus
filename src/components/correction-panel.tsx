'use client'

import { useState } from 'react'
import {
  correction,
  mustSayWhy,
  REASON_LIMIT,
  type CorrectionKind,
} from '@/modules/corrections/vocabulary'

/**
 * The one confirmation panel every correction opens (Phase 70).
 *
 * Four screens each grew their own. Payments asked for a reason and kept the
 * button disabled until it had one; payables asked for nothing and did it on
 * the first click; refunds opened a sentence and a button; deposits neither.
 * The words differed too — three of them said **"Take it back"**, meaning three
 * different things.
 *
 * Nothing here decides anything. The verb, the heading and whether a reason is
 * demanded all come from `corrections/vocabulary`, which is what the server
 * actions check against too — so a screen cannot ask for less than the action
 * will insist on, and cannot invent a verb that already means something else
 * one click away.
 *
 * The panel deliberately does **not** own which row is open. The button sits in
 * a row's action cell and the panel in a row of its own beneath it, which in a
 * table means two different cells; the board that owns the rows owns that.
 */

/** The button that opens it. Its label is the correction's verb, once. */
export function CorrectionButton({
  kind,
  open,
  onClick,
  disabled,
  className = 'btn btn-ghost text-xs',
}: {
  kind: CorrectionKind
  open: boolean
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button className={className} disabled={disabled} onClick={onClick} type="button">
      {/* One way out of every panel, on every screen. It was "Cancel" on
          payments — which on a screen full of things that can be cancelled is
          a fifth meaning nobody needed. */}
      {open ? 'Never mind' : correction(kind).verb}
    </button>
  )
}

export function CorrectionPanel({
  kind,
  /** What this will do, in the screen's own words — amounts, what goes back. */
  children,
  pending,
  onConfirm,
  /** Appended to the verb on the confirm button: an amount, or a number. */
  confirmSuffix,
}: {
  kind: CorrectionKind
  children: React.ReactNode
  pending?: boolean
  onConfirm: (reason: string | null) => void
  confirmSuffix?: string
}) {
  const entry = correction(kind)
  const needed = mustSayWhy(kind)
  const [reason, setReason] = useState('')

  const trimmed = reason.trim()
  const tooLong = trimmed.length > REASON_LIMIT
  const blocked = pending || tooLong || (needed && !trimmed)

  return (
    /* `sticky left-0` and the width cap: these panels live inside tables that
       scroll sideways on a phone, and a form that scrolls out of view is a form
       nobody can finish (found in the browser, Phase 68). */
    <div className="sticky left-0 max-w-[calc(100vw-3rem)] space-y-3">
      <div>
        <h4 className="text-sm font-semibold tracking-tight">{entry.title}</h4>
        <div className="mt-1 text-xs text-muted">{children}</div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[16rem] flex-1 text-xs text-muted">
          <span className="mb-1 block">
            {entry.reasonPrompt ?? 'Why, if it is worth recording'}
            {!needed && <span className="text-faint"> — optional</span>}
          </span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>
        <button
          className="btn btn-primary text-sm"
          disabled={blocked}
          onClick={() => onConfirm(trimmed || null)}
          type="button"
        >
          {entry.verb}
          {confirmSuffix ? ` — ${confirmSuffix}` : ''}
        </button>
      </div>

      {tooLong && (
        <p className="text-xs text-negative">
          That is longer than {REASON_LIMIT} characters. Keep the reason short — a note belongs on
          the record itself.
        </p>
      )}
    </div>
  )
}
