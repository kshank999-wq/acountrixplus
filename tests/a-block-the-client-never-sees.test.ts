import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { designDocuments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createProposal } from '@/modules/crm/proposals'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import {
  BLOCK_DEFINITIONS,
  lockProblems,
  parseBlocks,
  visibleBlocks,
  type Block,
} from '@/modules/design/blocks'
import { READER_SURFACES, readerSurfaceFor } from '@/modules/design/surfaces'
import { RegistryError } from '@/modules/errors/registry'
import { createDocumentForProposal, saveDocument } from '@/modules/design/documents'
import { DocumentPage } from '@/components/design/document-page'
import { renderDocumentPdf, type RenderInput } from '@/modules/pdf/layout'
import { renderEmailHtml, renderEmailText } from '@/modules/marketing/render-email'

/**
 * A block the client never sees (Phase 191, §7's `lock/hide`).
 *
 * ## What measuring the bullet found
 *
 * §7 asks for an *"Artboard/page system with multiple page sizes, guides,
 * rulers, snapping, grids, zoom, layers, grouping, alignment/distribution,
 * lock/hide, undo/redo"* — **twelve** things. ADR 0173's audit row named ten
 * of them and called the capability absent.
 *
 * Measured item by item, the way Phase 188 measured the client-link bullet:
 *
 *  - **Two are built and the row names neither** — the page system itself and
 *    multiple page sizes (`pageSizeEnum`, orientation, margins, running
 *    header and footer, page numbering, `pageBreak`).
 *  - **Five are properties of a canvas this engine deliberately is not** —
 *    guides, rulers, snapping, grids and object distribution all presuppose
 *    objects with coordinates. ADR 0004 decided against that model *from §7's
 *    own instruction*, and named `canvas` as the block type to add when it is
 *    wanted. A recorded decision with an extension point, not a gap.
 *  - **`lock/hide` needs no canvas at all**, and is genuinely missing.
 *
 * ## Why this is the shape it is
 *
 * `parseBlocks` is the single door every block list comes through — the
 * obvious place to drop a hidden block, and the wrong one, because it serves
 * the author and the reader alike. A filter there would hide the block from
 * the person who hid it.
 *
 * So `visibleBlocks` is named at each reader surface, `READER_SURFACES`
 * counts them, and the tests below render a hidden block through every one.
 * `BLOCK_SURFACES` exists because six of eight dispatches handle an unknown
 * block silently; this failure would be worse than those, because the block
 * shown is one an author deliberately held back and nobody is looking for it.
 */

const SECRET = 'ZZ-HELD-BACK-PRICE-BREAKDOWN'
const SHOWN_TEXT = 'ZZ-AGREED-SCOPE'

const BRAND = {
  surfaceColor: '#ffffff',
  primaryColor: '#0d6e60',
  accentColor: '#8fbc8f',
  textColor: '#111111',
  mutedColor: '#666666',
  headingFont: 'Helvetica-Bold',
  bodyFont: 'Helvetica',
  baseSizePt: 10,
}

const EMAIL_BRAND = {
  primaryColor: '#0d6e60',
  accentColor: '#8fbc8f',
  textColor: '#111111',
  mutedColor: '#666666',
  headingFont: 'Georgia, serif',
  bodyFont: 'Arial, sans-serif',
  baseSizePt: 14,
}

const SETUP = {
  pageSize: 'letter',
  orientation: 'portrait',
  marginTopPt: 54,
  marginRightPt: 54,
  marginBottomPt: 54,
  marginLeftPt: 54,
  headerText: null,
  footerText: null,
}

const DATA = {
  items: [],
  discountCents: 0,
  taxCents: 0,
  logoUrl: null,
  assetUrl: (assetId: string) => `/api/assets/${assetId}`,
}

/** One visible block and one hidden one, each carrying a findable marker. */
function mixed(): Block[] {
  return parseBlocks([
    { id: 'shown', type: 'text', text: SHOWN_TEXT, align: 'left', emphasis: false },
    { id: 'held', type: 'text', text: SECRET, align: 'left', emphasis: false, hidden: true },
  ])
}

function web(blocks: Block[], audience: 'author' | 'reader'): string {
  return renderToStaticMarkup(
    DocumentPage({ blocks, audience, setup: SETUP, brand: BRAND, context: {}, data: DATA }),
  )
}

function pdf(blocks: Block[]): string {
  const render: RenderInput = {
    blocks,
    brand: BRAND,
    merge: {},
    pageSize: 'letter',
    orientation: 'portrait',
    headerText: null,
    footerText: null,
    showPageNumbers: false,
    title: 'Proposal',
    author: 'Test Co',
    createdAt: new Date(0),
  }
  return renderDocumentPdf(render).toString('latin1')
}

/**
 * Each reader surface, as the thing a test can actually call.
 *
 * Keyed by `READER_SURFACES` rather than listed independently, and a test
 * below asserts the two agree — so a ninth reader surface fails here instead
 * of quietly showing held-back content.
 */
const RENDERERS: Record<string, (blocks: Block[]) => string> = {
  web: (blocks) => web(blocks, 'reader'),
  pdf,
  'email-html': (blocks) =>
    renderEmailHtml({ blocks, unsubscribeUrl: 'https://example.test/u/a', brand: EMAIL_BRAND }),
  'email-text': (blocks) =>
    renderEmailText({ blocks, unsubscribeUrl: 'https://example.test/u/a' }),
}

// ---------------------------------------------------------------------------

describe('what a reader never sees', () => {
  it.each(Object.keys(RENDERERS))('does not reach %s', (key) => {
    const surface = readerSurfaceFor(key)
    const output = RENDERERS[key](mixed())

    expect(output).toContain(SHOWN_TEXT)
    expect(
      output.includes(SECRET),
      `A hidden block reached ${surface.key}. ${surface.because}`,
    ).toBe(false)
  })

  it('has a renderer for every surface the register declares', () => {
    /*
      The register is only worth having if adding a row forces a test. A
      surface named there with nothing rendering through it here would be a
      surface this file reports as checked and does not check — which is the
      Phase 121 rule: a check only ever seen to agree is not a check.
    */
    expect(Object.keys(RENDERERS).sort()).toEqual(
      READER_SURFACES.map((surface) => surface.key).sort(),
    )
  })

  it('argues each surface in terms of what a leak costs', () => {
    for (const surface of READER_SURFACES) {
      expect(surface.because.length, `${surface.key} does not argue itself`).toBeGreaterThan(200)
      expect(surface.reader.length, `${surface.key} does not say who reads it`).toBeGreaterThan(10)
    }
  })

  it('refuses a surface key nobody declared', () => {
    /*
      A lookup answering `undefined` would report a surface as checked when
      nothing renders through it — the Phase 101 device, and the reason every
      register in this codebase throws.
    */
    expect(() => readerSurfaceFor('slack')).toThrow(RegistryError)
    expect(() => readerSurfaceFor('slack')).toThrow(/web, pdf, email-html, email-text/)
  })
})

describe('what an author always sees', () => {
  it('keeps a hidden block in the preview, and marks it', () => {
    const output = web(mixed(), 'author')

    /*
      A held-back block that simply vanished from the preview would look
      deleted, and the author would write it again. The preview has to answer
      "what is in this document" and "what will the client see" at once, which
      is why it is marked rather than dropped.
    */
    expect(output).toContain(SECRET)
    expect(output).toContain('doc-hidden-block')
    expect(output).toContain('Hidden')
  })

  it('does not mark a block that is not hidden', () => {
    const output = web(parseBlocks([
      { id: 'shown', type: 'text', text: SHOWN_TEXT, align: 'left', emphasis: false },
    ]), 'author')

    // Otherwise the first assertion would be equally true of a preview that
    // marked everything.
    expect(output).not.toContain('doc-hidden-block')
  })
})

describe('the flag itself', () => {
  it('defaults to visible and unlocked, so every stored document still parses', () => {
    /*
      The same bargain Phase 186's `crop` struck. A document written before
      this phase has neither field, and a parse that dropped it would empty
      every proposal in the database.
    */
    const [block] = parseBlocks([
      { id: 'old', type: 'text', text: 'Written before Phase 191.', align: 'left' },
    ])

    expect(block.hidden).toBe(false)
    expect(block.locked).toBe(false)
    expect(visibleBlocks([block])).toHaveLength(1)
  })

  it('is carried by every block type, because every type can be held back', () => {
    /*
      On the base rather than on the types that seemed to want it. There is no
      type for which "keep this but do not show it" is meaningless, and a flag
      that existed on some types would be a flag an author has to learn the
      rules of.
    */
    for (const definition of BLOCK_DEFINITIONS) {
      const block = definition.create('probe')
      expect(block.hidden, `${definition.type} has no hidden`).toBe(false)
      expect(block.locked, `${definition.type} has no locked`).toBe(false)
    }
  })
})

describe('a locked block', () => {
  const locked = (over: Record<string, unknown> = {}): Block[] =>
    parseBlocks([
      { id: 'a', type: 'text', text: 'Standard terms.', align: 'left', locked: true, ...over },
      { id: 'b', type: 'text', text: 'Scope.', align: 'left' },
    ])

  it('cannot be edited', () => {
    const after = parseBlocks([
      { id: 'a', type: 'text', text: 'Rewritten terms.', align: 'left', locked: true },
      { id: 'b', type: 'text', text: 'Scope.', align: 'left' },
    ])

    expect(lockProblems(locked(), after)).toEqual([expect.stringContaining('cannot be changed')])
  })

  it('cannot be deleted', () => {
    const after = parseBlocks([{ id: 'b', type: 'text', text: 'Scope.', align: 'left' }])

    expect(lockProblems(locked(), after)).toEqual([expect.stringContaining('cannot be deleted')])
  })

  it('cannot be moved, which is the clause the Design Assistant needs', () => {
    const after = parseBlocks([
      { id: 'b', type: 'text', text: 'Scope.', align: 'left' },
      { id: 'a', type: 'text', text: 'Standard terms.', align: 'left', locked: true },
    ])

    /*
      The first version of this rule covered content and existence only, and
      would have been **inert against the one caller it most exists to stop**:
      `applyLayoutSuggestion` is "reordered, never rewritten", so a lock that
      permitted reordering would not have protected a clause from the model at
      all. Phase 160's shape — installed and inert.
    */
    expect(lockProblems(locked(), after)).toEqual([expect.stringContaining('cannot be moved')])
  })

  it('can always be unlocked, because a lock nobody can undo is damage', () => {
    const after = parseBlocks([
      { id: 'a', type: 'text', text: 'Standard terms.', align: 'left', locked: false },
      { id: 'b', type: 'text', text: 'Scope.', align: 'left' },
    ])

    expect(lockProblems(locked(), after)).toEqual([])
  })

  it('does not freeze the document around it', () => {
    /*
      Position is compared among the blocks **common to both lists**, which is
      what keeps the rule usable: inserting a section above a locked clause is
      ordinary editing, and so is deleting an unlocked one elsewhere. A rule
      that refused those would be a lock on the whole document wearing one
      block's name.
    */
    const inserted = parseBlocks([
      { id: 'new', type: 'heading', text: 'Added above', level: 2, align: 'left' },
      { id: 'a', type: 'text', text: 'Standard terms.', align: 'left', locked: true },
      { id: 'b', type: 'text', text: 'Scope.', align: 'left' },
    ])
    expect(lockProblems(locked(), inserted)).toEqual([])

    const removedElsewhere = parseBlocks([
      { id: 'a', type: 'text', text: 'Standard terms.', align: 'left', locked: true },
    ])
    expect(lockProblems(locked(), removedElsewhere)).toEqual([])
  })

  it('says which block, so the message is actionable', () => {
    const after = parseBlocks([{ id: 'b', type: 'text', text: 'Scope.', align: 'left' }])

    // Phase 119: a refusal a person can act on. "A locked block prevented
    // this save" would leave somebody hunting through twelve blocks.
    const [problem] = lockProblems(locked(), after)
    expect(problem).toContain('Standard terms')
    expect(problem).toContain('Unlock it first')
  })
})

describe('the lock is enforced where it matters', () => {
  /** A real proposal document, because the save path is what is under test. */
  async function aDocument(fixture: Fixture, blocks: unknown) {
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

    const document = await createDocumentForProposal(fixture.ctx, proposal.id, 'blank')
    await saveDocument(fixture.ctx, document.id, { blocks })
    return document
  }

  it('refuses a save that would change a locked block', async () => {
    const fixture = await createCompanyFixture()
    const document = await aDocument(fixture, [
      { id: 'a', type: 'text', text: 'Approved wording.', align: 'left', locked: true },
    ])

    /*
      On the save path rather than only greyed out in the editor. A toggle
      only the editor respects is Phase 160's shape, and a browser tab left
      open from before the lock was set would save straight over it.
    */
    await expect(
      saveDocument(fixture.ctx, document.id, {
        blocks: [{ id: 'a', type: 'text', text: 'Rewritten.', align: 'left', locked: true }],
      }),
    ).rejects.toThrow(/locked/)

    const [row] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(parseBlocks(row.blocks)[0]).toMatchObject({ text: 'Approved wording.' })
  })

  it('allows the save that unlocks it', async () => {
    const fixture = await createCompanyFixture()
    const document = await aDocument(fixture, [
      { id: 'a', type: 'text', text: 'Approved wording.', align: 'left', locked: true },
    ])

    await saveDocument(fixture.ctx, document.id, {
      blocks: [{ id: 'a', type: 'text', text: 'Approved wording.', align: 'left', locked: false }],
    })

    await saveDocument(fixture.ctx, document.id, {
      blocks: [{ id: 'a', type: 'text', text: 'Rewritten.', align: 'left', locked: false }],
    })

    const [row] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    // Two steps instead of one, which is exactly what the lock is worth: it
    // costs an accident a deliberate act, and costs a deliberate act nothing.
    expect(parseBlocks(row.blocks)[0]).toMatchObject({ text: 'Rewritten.' })
  })

  it('leaves an unlocked document alone', async () => {
    const fixture = await createCompanyFixture()
    const document = await aDocument(fixture, [
      { id: 'a', type: 'text', text: 'Draft wording.', align: 'left' },
    ])

    await saveDocument(fixture.ctx, document.id, {
      blocks: [{ id: 'a', type: 'text', text: 'Edited freely.', align: 'left' }],
    })

    const [row] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(parseBlocks(row.blocks)[0]).toMatchObject({ text: 'Edited freely.' })
  })

  it('hides a block from a saved document without deleting it', async () => {
    const fixture = await createCompanyFixture()
    const document = await aDocument(fixture, [
      { id: 'a', type: 'text', text: SHOWN_TEXT, align: 'left' },
      { id: 'b', type: 'text', text: SECRET, align: 'left', hidden: true },
    ])

    const [row] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    const stored = parseBlocks(row.blocks)

    // Still in the document — the point of hiding rather than deleting — and
    // absent from every reader's copy of it.
    expect(stored).toHaveLength(2)
    expect(visibleBlocks(stored)).toHaveLength(1)
    expect(renderEmailHtml({
      blocks: stored,
      unsubscribeUrl: 'https://example.test/u/a',
      brand: EMAIL_BRAND,
    })).not.toContain(SECRET)
  })
})

describe('what this does not do', () => {
  it('is not a permission, and does not pretend to be', () => {
    /*
      Anybody who can edit the document can unlock it. Said in a test as well
      as in a docstring because a lock that looked like a permission would be
      worse than no lock — somebody would rely on it to keep a colleague out,
      and it does not.
    */
    const before = parseBlocks([
      { id: 'a', type: 'text', text: 'Approved.', align: 'left', locked: true },
    ])
    const unlockedThenChanged = parseBlocks([
      { id: 'a', type: 'text', text: 'Changed.', align: 'left', locked: false },
    ])

    // One save is refused; the two-step is not, and no role is consulted.
    expect(lockProblems(before, unlockedThenChanged)).toEqual([
      expect.stringContaining('cannot be changed'),
    ])
  })

  it('does not hide a block from its author anywhere', () => {
    /*
      The author surfaces are deliberately absent from `READER_SURFACES`. The
      designer, the block editor, the save path and the Design Assistant's
      outline all see every block, because hiding one from its author is how
      it gets lost — and `parseBlocks` stays the forgiving, unfiltered door it
      has always been.
    */
    const stored = mixed()
    expect(stored).toHaveLength(2)
    expect(web(stored, 'author')).toContain(SECRET)
  })
})
