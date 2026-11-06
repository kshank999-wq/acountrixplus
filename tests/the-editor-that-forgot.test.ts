import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { designDocuments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createProposal } from '@/modules/crm/proposals'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { applyTemplate, createDocumentForProposal, saveDocument } from '@/modules/design/documents'
import { parseBlocks, type Block } from '@/modules/design/blocks'
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  changeKey,
  currentBlocks,
  initialHistory,
  isDirty,
  reduceHistory,
  type HistoryState,
} from '@/modules/design/history'

/**
 * The editor that forgot (Phase 192, §7's `undo/redo`).
 *
 * ## Two problems, one question
 *
 * ADR 0191 nominated undo/redo as the last item of §7's artboard bullet
 * needing no canvas model. Building it meant deciding who owns `blocks` in
 * the designer, and that is where the second problem was.
 *
 * `useState(initialBlocks)` never re-reads its prop. Applying a template or
 * accepting an AI layout suggestion wrote the server and called
 * `router.refresh()`, which re-renders the server component and **does not
 * reseed client state**. Measured in a browser against the database:
 *
 * ```
 * DB before          : 17 blocks
 * apply a template   : 13 blocks on the server, 17 still on screen
 * author edits, saves: 17 blocks — the template is gone
 * ```
 *
 * §7's template gallery and §11's Design Assistant were both inert this way.
 * The tests below hold the two halves of the fix: a reducer that owns every
 * legal transition, and a server action that returns what it wrote.
 */

const text = (id: string, value: string): Block =>
  parseBlocks([{ id, type: 'text', text: value, align: 'left', emphasis: false }])[0]

const heading = (id: string, value: string): Block =>
  parseBlocks([{ id, type: 'heading', text: value, level: 2, align: 'left' }])[0]

/** A history advanced through a list of edits, each a second apart. */
function after(initial: Block[], edits: Block[][], gap = COALESCE_MS + 1): HistoryState {
  let state = initialHistory(initial)
  let clock = 0
  for (const blocks of edits) {
    clock += gap
    state = reduceHistory(state, { type: 'edit', blocks, at: clock })
  }
  return state
}

// ---------------------------------------------------------------------------

describe('undo and redo', () => {
  const one = [text('a', 'One')]
  const two = [text('a', 'Two')]
  const three = [text('a', 'Three')]

  it('walks back and forward through the steps', () => {
    let state = after(one, [two, three])

    expect(currentBlocks(state)).toEqual(three)
    state = reduceHistory(state, { type: 'undo' })
    expect(currentBlocks(state)).toEqual(two)
    state = reduceHistory(state, { type: 'undo' })
    expect(currentBlocks(state)).toEqual(one)

    expect(canUndo(state)).toBe(false)
    state = reduceHistory(state, { type: 'undo' })
    expect(currentBlocks(state)).toEqual(one)

    state = reduceHistory(state, { type: 'redo' })
    expect(currentBlocks(state)).toEqual(two)
  })

  it('discards the future when a new edit follows an undo', () => {
    let state = after(one, [two, three])
    state = reduceHistory(state, { type: 'undo' })
    state = reduceHistory(state, { type: 'edit', blocks: [text('a', 'Other')], at: 9_000 })

    // The standard rule, and the one that matters: redo must not offer a
    // branch the author abandoned.
    expect(canRedo(state)).toBe(false)
    expect(currentBlocks(state)).toEqual([text('a', 'Other')])
  })

  it('keeps a bounded number of steps', () => {
    const edits = Array.from({ length: HISTORY_LIMIT + 20 }, (_, n) => [text('a', `v${n}`)])
    const state = after(one, edits)

    /*
      Every entry is a whole copy of the document, so this is a memory bound
      rather than a view about how far back anybody wants to go.
    */
    expect(state.entries).toHaveLength(HISTORY_LIMIT)
    expect(currentBlocks(state)).toEqual([text('a', `v${HISTORY_LIMIT + 19}`)])
  })
})

describe('what counts as one step', () => {
  it('merges consecutive keystrokes in the same field', () => {
    let state = initialHistory([text('a', '')])
    for (const [index, value] of ['H', 'He', 'Hel', 'Hell', 'Hello'].entries()) {
      state = reduceHistory(state, { type: 'edit', blocks: [text('a', value)], at: index * 100 })
    }

    /*
      Every keystroke calls `onChange`, so without this a sentence would be
      forty undos. One step: the original and the typed word.
    */
    expect(state.entries).toHaveLength(2)
    expect(currentBlocks(reduceHistory(state, { type: 'undo' }))).toEqual([text('a', '')])
  })

  it('starts a new step after a pause', () => {
    let state = initialHistory([text('a', '')])
    state = reduceHistory(state, { type: 'edit', blocks: [text('a', 'Hello')], at: 0 })
    state = reduceHistory(state, {
      type: 'edit',
      blocks: [text('a', 'Hello there')],
      at: COALESCE_MS + 1,
    })

    // Typing, stopping to think, and typing again is two thoughts.
    expect(state.entries).toHaveLength(3)
  })

  it('starts a new step when the field changes', () => {
    let state = initialHistory([text('a', ''), heading('b', '')])
    state = reduceHistory(state, {
      type: 'edit',
      blocks: [text('a', 'Body'), heading('b', '')],
      at: 0,
    })
    state = reduceHistory(state, {
      type: 'edit',
      blocks: [text('a', 'Body'), heading('b', 'Title')],
      at: 50,
    })

    // Within the window, but a different block — so the time rule alone would
    // have merged two separate edits into one undo.
    expect(state.entries).toHaveLength(3)
  })

  it.each([
    ['adding a block', [text('a', 'One'), text('b', 'Two')]],
    ['deleting a block', []],
    ['reordering', [text('b', 'Two'), text('a', 'One')]],
  ])('never merges %s', (_label, next) => {
    const start = [text('a', 'One'), text('b', 'Two')]
    let state = initialHistory(start)
    state = reduceHistory(state, { type: 'edit', blocks: next as Block[], at: 0 })
    state = reduceHistory(state, { type: 'edit', blocks: next as Block[], at: 10 })

    // Each structural change is one deliberate act and should cost one undo.
    expect(state.entries.length).toBeGreaterThanOrEqual(3)
  })

  it('reads a change rather than being told about it', () => {
    /*
      Inferred, not labelled by the caller. A tag each `update()` site had to
      pass would be a thing a new call site forgets — which is the finding
      `BLOCK_SURFACES` exists because of.
    */
    expect(changeKey([text('a', 'x')], [text('a', 'y')])).toBe('a:text')
    expect(changeKey([text('a', 'x')], [text('a', 'x')])).toBeNull()
    expect(changeKey([text('a', 'x')], [])).toBeNull()
    expect(changeKey([text('a', 'x')], [text('b', 'x')])).toBeNull()

    // Two fields of one block at once is not a keystroke, so it does not merge.
    const both = parseBlocks([
      { id: 'a', type: 'text', text: 'y', align: 'right', emphasis: false },
    ])
    expect(changeKey([text('a', 'x')], both)).toBeNull()
  })
})

describe('whether there is anything to save', () => {
  it('is false again when you undo back to the saved state', () => {
    let state = initialHistory([text('a', 'One')])
    expect(isDirty(state)).toBe(false)

    state = reduceHistory(state, { type: 'edit', blocks: [text('a', 'Two')], at: 0 })
    expect(isDirty(state)).toBe(true)

    /*
      The improvement that falls out of the reducer for free. The old `dirty`
      boolean was set by any edit and cleared only by a save, so typing a
      character and deleting it left the document unsaved forever — and that
      flag gates the Design Assistant's button, so a no-op edit disabled the
      assistant until somebody saved nothing.
    */
    state = reduceHistory(state, { type: 'undo' })
    expect(isDirty(state)).toBe(false)
  })

  it('does not report saved work as saved after one more keystroke', () => {
    let state = initialHistory([text('a', '')])
    state = reduceHistory(state, { type: 'edit', blocks: [text('a', 'Hel')], at: 0 })
    state = reduceHistory(state, { type: 'saved' })

    /*
      A save is a boundary. Without clearing the coalescing key it would merge
      the next keystroke **into the entry the server holds**, leaving
      `savedAt` pointing at changed content — so the button would say "Saved"
      with unsaved work in the box. Found by reading the interaction.
    */
    state = reduceHistory(state, { type: 'edit', blocks: [text('a', 'Hell')], at: 10 })
    expect(isDirty(state)).toBe(true)
  })

  it('offers to save when the saved state has fallen off the history', () => {
    let state = initialHistory([text('a', 'original')])
    const edits = Array.from({ length: HISTORY_LIMIT + 5 }, (_, n) => [text('a', `v${n}`)])
    state = after([text('a', 'original')], edits)

    // The saved entry was trimmed, so nothing can prove the document is
    // unchanged — and offering to save it is the safe answer.
    expect(state.savedAt).toBeNull()
    expect(isDirty(state)).toBe(true)
  })
})

describe('when the server replaces the document', () => {
  it('shows what the server wrote, and counts it as saved', () => {
    let state = initialHistory([text('a', 'Mine')])
    const template = [heading('t1', 'Executive summary'), text('t2', 'From the template')]

    state = reduceHistory(state, { type: 'replace', blocks: template, at: 1000 })

    expect(currentBlocks(state)).toEqual(template)
    expect(isDirty(state)).toBe(false)
  })

  it('can be undone, because that is when anybody reaches for undo', () => {
    let state = initialHistory([text('a', 'Mine')])
    state = reduceHistory(state, { type: 'replace', blocks: [heading('t', 'Template')], at: 1000 })
    state = reduceHistory(state, { type: 'undo' })

    /*
      "Applying a template replaces everything in this document" is the
      warning on the button, and the moment somebody reads it properly is
      just after they clicked. The old content comes back, and now shows as
      unsaved — correctly, because saving is how the undo would be kept.
    */
    expect(currentBlocks(state)).toEqual([text('a', 'Mine')])
    expect(isDirty(state)).toBe(true)
  })

  it('never merges with the edit before it', () => {
    let state = initialHistory([text('a', '')])
    state = reduceHistory(state, { type: 'edit', blocks: [text('a', 'x')], at: 0 })
    state = reduceHistory(state, { type: 'replace', blocks: [text('a', 'y')], at: 10 })

    // Inside the coalescing window and still its own step: a replacement is
    // not a keystroke, whatever it happens to look like.
    expect(state.entries).toHaveLength(3)
  })
})

describe('the action tells the client what it wrote', () => {
  async function aDocument(fixture: Fixture) {
    const organization = await createOrganization(fixture.ctx, { name: 'Northwind Ltd' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Riverside survey',
    })
    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Riverside survey',
      items: [{ description: 'Survey', quantityMilli: 1000, unitPriceCents: 1_000_00 }],
    })
    return createDocumentForProposal(fixture.ctx, proposal.id, 'blank')
  }

  it('returns the blocks it wrote, which is what the editor had no way to know', async () => {
    const fixture = await createCompanyFixture()
    const document = await aDocument(fixture)

    await saveDocument(fixture.ctx, document.id, {
      blocks: [{ id: 'mine', type: 'text', text: 'Written by hand.', align: 'left' }],
    })

    const updated = await applyTemplate(fixture.ctx, document.id, 'standard-services')
    const written = parseBlocks(updated.blocks)

    /*
      The server half of the fix. `applyTemplate` already returned the row; the
      action threw it away and called `router.refresh()`, which cannot reseed
      client state. Nothing but the action knows the document was replaced
      *and* by what.
    */
    expect(written.length).toBeGreaterThan(1)
    expect(written.map((block) => block.id)).not.toContain('mine')

    const [row] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(parseBlocks(row.blocks)).toEqual(written)
  })

  it('would have been overwritten by the stale editor, and now is not', async () => {
    const fixture = await createCompanyFixture()
    const document = await aDocument(fixture)

    const mine: unknown[] = [{ id: 'mine', type: 'text', text: 'Written by hand.', align: 'left' }]
    await saveDocument(fixture.ctx, document.id, { blocks: mine })

    const applied = parseBlocks(
      (await applyTemplate(fixture.ctx, document.id, 'standard-services')).blocks,
    )

    /*
      The defect, as a sequence. A client holding `mine` and saving after the
      template landed put `mine` back — measured in a browser against the
      database before this phase. The reducer is what stops it: `replace`
      moves the editor to `applied`, so the next save writes that.
    */
    const stale = initialHistory(parseBlocks(mine))
    expect(currentBlocks(stale)).not.toEqual(applied)

    const current = reduceHistory(stale, { type: 'replace', blocks: applied, at: 1 })
    expect(currentBlocks(current)).toEqual(applied)

    await saveDocument(fixture.ctx, document.id, { blocks: currentBlocks(current) })

    const [row] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(parseBlocks(row.blocks)).toEqual(applied)
  })
})

describe('what this does not do', () => {
  it('does not survive leaving the page', () => {
    /*
      The history is client state. Closing the tab loses it, and there is no
      navigation guard either — which was true before this phase and is more
      galling now, because an editor with undo invites somebody to trust it.
      Named rather than fixed: a guard is a different change, and a history
      that outlived the page would be a second copy of the document competing
      with the server's.
    */
    const state = initialHistory([text('a', 'One')])
    expect(state.entries).toHaveLength(1)
    expect(canUndo(state)).toBe(false)
  })

  it('reads no clock of its own', () => {
    /*
      Every timestamp arrives on the action, which is the same decision
      `writePdf` makes about `createdAt`. A reducer that called `Date.now()`
      would be one no test could pin, and the coalescing rule is the part most
      worth pinning.
    */
    const first = after([text('a', '')], [[text('a', 'x')], [text('a', 'xy')]])
    const second = after([text('a', '')], [[text('a', 'x')], [text('a', 'xy')]])

    expect(first).toEqual(second)
  })
})
