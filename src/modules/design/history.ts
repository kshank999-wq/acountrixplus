/**
 * The designer's block state, and every way it is allowed to move
 * (Phase 192, §7's `undo/redo`).
 *
 * ## Two problems that turned out to be one
 *
 * §7's artboard bullet asks for undo/redo, and Phase 191 measured it as the
 * last item of that bullet needing no canvas model. Building it meant looking
 * at who owns `blocks` in `designer.tsx`, and that is where the second problem
 * was:
 *
 * > `useState(initialBlocks)` never re-reads its prop. Applying a template or
 * > an AI layout suggestion wrote the server and called `router.refresh()`,
 * > which re-renders the server component and **does not reseed client
 * > state** — so the editor went on showing the old document, and the next
 * > save overwrote the thing that had just been applied.
 *
 * Measured in a browser against the database: 17 blocks, apply a template, 13
 * blocks on the server and 17 still on screen, make any edit, save — 17 blocks
 * again, and the template is gone. §7's template gallery and §11's Design
 * Assistant were both inert this way, which is Phase 160's shape.
 *
 * They are one problem because they are one question: **what are the legal
 * transitions of the editor's block list?** A history that did not know about
 * a server replacement would undo straight past it; a server replacement that
 * did not go through the history would be the same dropped update in a new
 * place. So there is one reducer, and `replace` is one of its actions.
 *
 * ## Pure, and the clock is an argument
 *
 * Coalescing needs to know how long ago the last edit was, and a reducer that
 * read `Date.now()` would be a reducer no test could pin. The timestamp comes
 * in on the action, which is the same decision `writePdf` makes about
 * `createdAt` and for the same reason: *nothing here reads a clock*.
 */

import type { Block } from './blocks'

/**
 * How many steps are kept.
 *
 * A document is a `jsonb` blob of some size and every entry is a whole copy of
 * it, so this is a memory bound rather than a judgement about how far back
 * anybody wants to go. Hundred-deep is well past where a person stops trusting
 * undo and still small enough that a large proposal's history is a few
 * megabytes.
 */
export const HISTORY_LIMIT = 100

/**
 * How long a pause ends a step.
 *
 * Every keystroke in the block editor calls `onChange`, so without coalescing
 * a sentence would be forty undos. The rule has two halves and needs both:
 * consecutive edits merge only while they touch **the same field of the same
 * block**, which handles moving between fields, and only within this window,
 * which handles typing, stopping to think, and typing again in the same box.
 *
 * A second is where a person stops typing a thought rather than a word.
 */
export const COALESCE_MS = 1000

export type HistoryState = {
  /** Oldest first. Always at least one entry. */
  entries: Block[][]
  /** Which entry is on screen. */
  at: number
  /**
   * The entry the server holds, or `null` when that is no longer in the list.
   *
   * `null` rather than a guess, because this drives whether the Save button is
   * offered. A document whose saved state has been trimmed off the back of the
   * history is a document nobody can prove is unchanged, and offering to save
   * it is the safe answer.
   */
  savedAt: number | null
  /** `blockId:field` of the last coalescable edit, or null if it was structural. */
  lastKey: string | null
  /** When that edit happened, in milliseconds. */
  lastAt: number
}

export type HistoryAction =
  | { type: 'edit'; blocks: Block[]; at: number }
  | { type: 'replace'; blocks: Block[]; at: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'saved' }

export function initialHistory(blocks: Block[]): HistoryState {
  return { entries: [blocks], at: 0, savedAt: 0, lastKey: null, lastAt: 0 }
}

export function currentBlocks(state: HistoryState): Block[] {
  return state.entries[state.at]
}

export function canUndo(state: HistoryState): boolean {
  return state.at > 0
}

export function canRedo(state: HistoryState): boolean {
  return state.at < state.entries.length - 1
}

/**
 * Whether there is anything to save.
 *
 * Computed from the history rather than tracked as a flag, which is the one
 * user-visible improvement that falls out of this for free. The old `dirty`
 * boolean was set on any edit and cleared only by a save, so typing a
 * character and deleting it left the document "unsaved" forever — and that
 * flag also gated the Design Assistant button, so a no-op edit disabled the
 * assistant until somebody saved nothing.
 *
 * Undoing back to the saved state now genuinely clears it, because the
 * question "has this changed" has one answer and the history knows it.
 */
export function isDirty(state: HistoryState): boolean {
  return state.savedAt !== state.at
}

/**
 * What a single edit changed, as `blockId:field`, or `null` if it was not one
 * field of one block.
 *
 * Inferred rather than labelled by the caller. The alternative is for each
 * `update()` site to pass a tag, and this codebase's recurring finding is that
 * a thing each call site must remember is a thing a new call site forgets —
 * `BLOCK_SURFACES` exists because of exactly that. Inference costs a
 * comparison and covers call sites nobody has written yet.
 *
 * Structural changes — adding, deleting, reordering, hiding, locking — return
 * `null` and therefore never coalesce, which is right: each is one deliberate
 * act and each should cost one undo.
 */
export function changeKey(before: Block[], after: Block[]): string | null {
  if (before.length !== after.length) return null

  let changed: number | null = null
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === after[index]) continue
    if (JSON.stringify(before[index]) === JSON.stringify(after[index])) continue
    if (changed !== null) return null
    changed = index
  }

  if (changed === null) return null

  const from = before[changed] as unknown as Record<string, unknown>
  const to = after[changed] as unknown as Record<string, unknown>
  if (from.id !== to.id) return null

  const keys = new Set([...Object.keys(from), ...Object.keys(to)])
  let field: string | null = null
  for (const key of keys) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue
    if (field !== null) return null
    field = key
  }

  return field === null ? null : `${String(from.id)}:${field}`
}

export function reduceHistory(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'edit':
      return push(state, action.blocks, action.at, changeKey(currentBlocks(state), action.blocks))

    case 'replace': {
      /*
        The server replaced the document — a template applied, or a layout
        suggestion accepted.

        Pushed as an ordinary entry, so it can be undone: applying a template
        by accident is exactly when somebody reaches for undo, and the warning
        on the button ("replaces everything in this document") is the moment
        they realise. `savedAt` moves to it because the server now holds
        exactly this, which makes an undo show as unsaved work — correctly,
        since saving is how the undo would be kept.
      */
      const next = push(state, action.blocks, action.at, null)
      return { ...next, savedAt: next.at }
    }

    case 'undo':
      if (!canUndo(state)) return state
      // `lastKey` is cleared so the next keystroke starts a step rather than
      // merging into the one that was undone past.
      return { ...state, at: state.at - 1, lastKey: null }

    case 'redo':
      if (!canRedo(state)) return state
      return { ...state, at: state.at + 1, lastKey: null }

    case 'saved':
      /*
        `lastKey` is cleared because a save is a boundary.

        Without that: save, then type another character into the same field
        within the coalescing window, and the edit would merge **into the
        entry the server holds** while `savedAt` still pointed at it — so the
        button would say "Saved" with unsaved work in the box. Found by
        reading the interaction rather than by a test, and then given one.
      */
      return { ...state, savedAt: state.at, lastKey: null }
  }
}

function push(
  state: HistoryState,
  blocks: Block[],
  at: number,
  key: string | null,
): HistoryState {
  /*
    A keystroke in the same field, soon after the last one, replaces the
    current entry instead of adding to it. Note that this still truncates the
    future, because an edit after an undo is a new branch however small it is.
  */
  const coalesce = key !== null && key === state.lastKey && at - state.lastAt <= COALESCE_MS

  if (coalesce) {
    const entries = [...state.entries.slice(0, state.at), blocks]
    return {
      entries,
      at: entries.length - 1,
      savedAt: state.savedAt !== null && state.savedAt < entries.length ? state.savedAt : null,
      lastKey: key,
      lastAt: at,
    }
  }

  const entries = [...state.entries.slice(0, state.at + 1), blocks]
  let savedAt = state.savedAt !== null && state.savedAt < entries.length ? state.savedAt : null
  let index = entries.length - 1

  // Trim from the front, which moves every index with it.
  if (entries.length > HISTORY_LIMIT) {
    const dropped = entries.length - HISTORY_LIMIT
    entries.splice(0, dropped)
    index -= dropped
    savedAt = savedAt === null || savedAt - dropped < 0 ? null : savedAt - dropped
  }

  return { entries, at: index, savedAt, lastKey: key, lastAt: at }
}
