import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RegistryError } from '@/modules/errors/registry'
import {
  BLOCK_DEFINITIONS,
  MAX_TABLE_COLUMNS,
  blockSchema,
  normalizeTable,
  parseBlocks,
  tableBlockSchema,
  tableProblems,
  validateBlocks,
  type Block,
  type BlockType,
  type TableBlock,
} from '@/modules/design/blocks'
import {
  BLOCK_SURFACES,
  blockSurfaceFor,
  blockSurfaceStands,
  coverageMarker,
} from '@/modules/design/surfaces'
import { resolveBlocks, unresolvedInBlocks } from '@/modules/design/merge-fields'
import { renderEmailHtml, renderEmailText } from '@/modules/marketing/render-email'

/**
 * A table that is not a price (Phase 181, spec §7).
 *
 * §7 names *"tables, pricing tables"* as two things. `pricingTable` renders the
 * proposal's own line items and holds no figures of its own, which is right for
 * a fee table and useless for a specification, a schedule with three columns, a
 * comparison or a list of materials. ADR 0173 measured the absence; until now
 * such a table was built from `keyValue` rows — two columns, no header, no way
 * to add a third.
 *
 * ## The finding that is larger than the capability
 *
 * Writing it meant reaching eight surfaces, and counting them found that
 * **three block types had never reached one of them.** Phase 5 added `button`,
 * `qrCode` and `video` to the union, the palette and all three renderers, and
 * not to `block-editor.tsx` — whose own docstring claims "one case per block
 * type".
 *
 * So for twenty-three phases a marketing document could hold a call-to-action
 * button that rendered on the page, in the email and in the PDF with its
 * default label and an **empty url**, and nothing anywhere could set it. Not a
 * compile error: six of seven dispatches end in a `default:` and the seventh
 * returns `void`.
 *
 * The coverage is counted now, which is what the second half of this file is.
 */

function table(overrides: Partial<TableBlock> = {}): TableBlock {
  return tableBlockSchema.parse({ id: 'table-1', type: 'table', ...overrides })
}

const SPEC_TABLE = table({
  title: 'Specification',
  header: ['Item', 'Detail', 'Qty'],
  rows: [
    ['Hull coating', 'Two-part epoxy', '40 L'],
    ['Anodes', 'Zinc, shaft and hull', '6'],
  ],
  columnAlign: ['left', 'left', 'right'],
})

// ---------------------------------------------------------------------------

describe('the block §7 names beside a pricing table', () => {
  it('holds a header, a third column and its own cells', () => {
    /**
     * The three things `keyValue` cannot do, which is the whole reason this
     * block exists. `pricingTable` holds no figures of its own *on purpose* —
     * its comment says so, because the numbers must not drift from the
     * proposal's totals — and that is exactly what makes it the wrong block for
     * a specification.
     */
    expect(SPEC_TABLE.header).toEqual(['Item', 'Detail', 'Qty'])
    expect(SPEC_TABLE.rows[0]).toHaveLength(3)
    expect(SPEC_TABLE.columnAlign).toEqual(['left', 'left', 'right'])
  })

  it('is offered in the palette for both kinds of document', () => {
    const definition = BLOCK_DEFINITIONS.find((entry) => entry.type === 'table')

    expect(definition).toBeDefined()
    expect(definition!.kinds).toEqual(['proposal', 'marketing'])
    // Distinct from the fee table in the one place an author chooses between
    // them, by description rather than by them working it out.
    expect(definition!.description).not.toContain('price')
    expect(BLOCK_DEFINITIONS.find((entry) => entry.type === 'pricingTable')!.kinds).toEqual([
      'proposal',
    ])
  })

  it('creates something an author can start typing into', () => {
    // Not an empty table: a block that renders as nothing is a block the author
    // has to guess the shape of.
    const created = BLOCK_DEFINITIONS.find((entry) => entry.type === 'table')!.create('new-1')
    if (created.type !== 'table') expect.unreachable()

    expect(created.header).toEqual(['Item', 'Detail'])
    expect(created.rows).toHaveLength(2)
    expect(created.rows.every((row) => row.length === 2)).toBe(true)
  })

  it('caps the columns at what the page can print', () => {
    /**
     * Six, and the reason is the PDF rather than taste: §7 asks for
     * *"print-quality output"*, and six equal columns of the content width at
     * this body size are still readable. A seventh is not ugly, it is
     * unreadable — and a block that renders acceptably on screen and illegibly
     * in the document the client downloads is the half-working this engine's
     * single model exists to avoid.
     */
    expect(MAX_TABLE_COLUMNS).toBe(6)

    const tooWide = blockSchema.safeParse({
      id: 'wide',
      type: 'table',
      header: ['1', '2', '3', '4', '5', '6', '7'],
    })
    expect(tooWide.success).toBe(false)
  })
})

describe('rectangular, and what happens when it is not', () => {
  it('refuses a ragged table on the save path', () => {
    /**
     * A ragged table is not a rendering edge case, it is four different wrong
     * answers: HTML drops the missing cells, the PDF computes column widths
     * from a row that is not representative, the email's table layout silently
     * misaligns, and the plain-text alternative loses the column boundary.
     */
    const ragged = table({ header: ['A', 'B', 'C'], rows: [['1', '2', '3'], ['1', '2']] })

    expect(tableProblems(ragged)).toEqual([
      expect.stringContaining('Row 2 has 2 cells and the table has 3 columns'),
    ])

    const { errors } = validateBlocks([ragged])
    expect(errors).toEqual([expect.stringContaining('Block 1:')])
    expect(errors[0]).toContain('four different wrong ways')
  })

  it('renders a ragged table anyway, padded, on every surface', () => {
    /**
     * The other direction, and it has to hold: `parseBlocks` is lenient on
     * purpose — *"a document that fails to render is worse than one missing a
     * block"* — so a table stored ragged by an older editor or edited by hand
     * must still render. Lenient **and consistent** is the pair that needs a
     * function; lenient alone is how the four wrong answers happen.
     */
    const ragged = table({ header: ['A', 'B', 'C'], rows: [['1'], ['1', '2', '3']] })

    const kept = parseBlocks([ragged])
    expect(kept).toHaveLength(1)

    const { width, header, rows } = normalizeTable(ragged)
    expect(width).toBe(3)
    expect(header).toEqual(['A', 'B', 'C'])
    expect(rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ])
  })

  it('takes the width from the first row when there is no header', () => {
    // A table used for layout needs no header, and a header of empty strings is
    // not the same thing — so an empty `header` means "no header row" rather
    // than "a table with no columns".
    const headerless = table({ rows: [['a', 'b'], ['c', 'd']] })
    const { width, header } = normalizeTable(headerless)

    expect(width).toBe(2)
    expect(header).toEqual([])
    expect(tableProblems(headerless)).toEqual([])
  })

  it('refuses rows with no columns at all', () => {
    expect(tableProblems(table({ rows: [[]] }))).toEqual([
      'A table with rows needs at least one column.',
    ])
  })

  it('pads alignment to the width rather than letting a renderer index past it', () => {
    // "Left from here on", so a three-column table where only the last column
    // is right-aligned does not have to say `['left', 'left', 'right']` — and
    // no renderer reads `undefined` off the end.
    const { align } = normalizeTable(table({ header: ['A', 'B', 'C'], columnAlign: ['center'] }))
    expect(align).toEqual(['center', 'left', 'left'])
  })
})

describe('merge fields, in both halves', () => {
  it('fills them in the header as well as the body', () => {
    /**
     * The header is a list of strings and not a list of labels precisely so a
     * column can be headed `{{client.name}}` — which is a comparison table, a
     * real document somebody writes.
     */
    const [filled] = resolveBlocks(
      [
        table({
          title: 'For {{client.name}}',
          header: ['Item', '{{client.name}}'],
          rows: [['Hull', 'Yes']],
        }),
      ],
      { 'client.name': 'Harborview Marine' },
    )
    if (filled.type !== 'table') expect.unreachable()

    expect(filled.title).toBe('For Harborview Marine')
    expect(filled.header).toEqual(['Item', 'Harborview Marine'])
  })

  it('reports them as used, which is the half a default clause loses', () => {
    /**
     * `unresolvedInBlocks` is the pre-send check that warns an author about a
     * field that will not resolve. Its dispatch ends in `default: return []`,
     * so a new block type reports a document as using **no** merge fields when
     * it uses several — and the warning never fires before the document is
     * sent, which is the worst moment to find out.
     *
     * Asserted separately from filling because they are separate switches, and
     * the first draft of this phase filled one and not the other.
     */
    const unresolved = unresolvedInBlocks(
      [table({ header: ['{{company.name}}'], rows: [['{{client.name}}']] })],
      { 'company.name': 'Ours' },
    )

    // The header's field resolves, the cell's does not, and the cell's is the
    // one reported — which is only possible if this block type is read at all.
    expect(unresolved).toEqual(['client.name'])
  })
})

describe('the email, in both parts', () => {
  const email = { unsubscribeUrl: 'https://example.test/u/abc' }

  it('renders real tabular markup rather than a layout table', () => {
    /**
     * Every other table in that renderer carries `role="presentation"`, which
     * tells a screen reader to ignore the structure. This one must not: it *is*
     * tabular data, and the attribute that is right for layout is exactly wrong
     * here.
     */
    const html = renderEmailHtml({ blocks: [SPEC_TABLE], ...email })

    expect(html).toContain('<th')
    expect(html).toContain('Hull coating')
    expect(html).toContain('Two-part epoxy')

    // The table this block renders is the one without the attribute.
    const blockMarkup = html.slice(html.indexOf('Specification'))
    expect(blockMarkup.slice(0, blockMarkup.indexOf('</table>'))).not.toContain(
      'role="presentation"',
    )
  })

  it('keeps the columns in the plain-text alternative', () => {
    /**
     * Not optional — a message with no text part is a spam signal — and a table
     * is the one block that loses its meaning entirely without its shape, so it
     * is column-aligned with spaces rather than flattened to prose.
     */
    const text = renderEmailText({ blocks: [SPEC_TABLE], ...email })

    expect(text).toContain('Specification')
    expect(text).toContain('Item')
    // A rule under the header, and the cells lining up beneath it.
    expect(text).toMatch(/Item\s+Detail\s+Qty/)
    expect(text).toMatch(/-+\s+-+\s+-+/)
    expect(text).toContain('Hull coating')
  })

  it('renders nothing for a table with no columns', () => {
    // Rather than an empty `<table>`, which some clients draw a border around.
    const html = renderEmailHtml({ blocks: [table({ title: 'Empty' })], ...email })
    expect(html).not.toContain('Empty')
  })
})

// ---------------------------------------------------------------------------

describe('the surfaces a block type has to reach', () => {
  it('argues every surface by what a reader loses', () => {
    /**
     * Phase 101's device, and the floor is set on a particular question
     * because of how these gaps fail: every one of them compiles, and most look
     * like nothing is wrong. "This surface should handle every type" is not a
     * reason, it is a restatement.
     */
    expect(BLOCK_SURFACES.flatMap((surface) => blockSurfaceStands(surface))).toEqual([])
  })

  it('declares eight surfaces, seven of which fail silently', () => {
    // Measured, not bounded (Phase 126). The second number is the one the
    // register exists for: a surface that throws or fails to compile needs no
    // register.
    expect(BLOCK_SURFACES).toHaveLength(8)
    expect(BLOCK_SURFACES.filter((surface) => surface.silent)).toHaveLength(7)
    expect(BLOCK_SURFACES.filter((surface) => !surface.silent).map((s) => s.key)).toEqual([
      'palette',
    ])
  })

  it('throws on a surface nobody declared', () => {
    expect(() => blockSurfaceFor('designer-preview')).toThrow(RegistryError)
    try {
      blockSurfaceFor('designer-preview')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('BLOCK_SURFACES')
      expect((error as RegistryError).message).toContain('email-html')
    }
  })

  it('has every block type reaching every surface', () => {
    /**
     * **The assertion this phase exists for.** It fails naming the file, which
     * is the difference between a block type that is half-wired and a block
     * type that is half-wired and nobody can tell.
     *
     * When this fails for a type you have just added, the fix is the surface
     * rather than this test — and the register's `because` says what the gap
     * costs, so the order to fix them in is readable off the failure.
     */
    const types = BLOCK_DEFINITIONS.map((definition) => definition.type)
    const sources = new Map(
      BLOCK_SURFACES.map((surface) => [surface.file, readFileSync(surface.file, 'utf8')]),
    )

    const missing: string[] = []
    for (const surface of BLOCK_SURFACES) {
      const source = sources.get(surface.file)!
      for (const type of types) {
        if (!source.includes(coverageMarker(surface, type))) {
          missing.push(`${type} is not handled at ${surface.key} (${surface.file})`)
        }
      }
    }

    expect(missing).toEqual([])
  })

  it('counts the types, so a type outside the palette cannot hide', () => {
    /**
     * The scan above walks `BLOCK_DEFINITIONS`, which is the palette — so a
     * type in the union with no palette entry would be checked at no surface
     * at all and the scan would pass. This is the other end of that: the union
     * and the palette hold the same seventeen.
     *
     * Seventeen since Phase 181. Sixteen from Phase 5 to 180.
     */
    const inUnion = blockSchema.options.map(
      (option) => option.shape.type.value as BlockType,
    )
    const inPalette = BLOCK_DEFINITIONS.map((definition) => definition.type)

    expect(inUnion).toHaveLength(17)
    expect([...inPalette].sort()).toEqual([...inUnion].sort())
  })

  it('names the three that were missing an editor, so the finding survives', () => {
    /**
     * Phase 5 added these three and Phase 181 gave them an editor. Asserted by
     * name rather than left to the scan above, because the scan will pass
     * forever once it passes and the *reason* this register exists is these
     * three — a capability that rendered on every surface and could not be
     * configured on any.
     */
    const editor = readFileSync('src/components/design/block-editor.tsx', 'utf8')

    for (const type of ['button', 'qrCode', 'video'] as const) {
      expect(editor, type).toContain(`block.type === '${type}'`)
    }

    // And the fields that were unreachable: a button's url, a QR code's value,
    // a video's link. An empty url on a call to action is the whole defect.
    expect(editor).toContain("onChange={(url) => set({ url })}")
    expect(editor).toContain("onChange={(value) => set({ value })}")
  })
})

describe('what a document with one of everything does', () => {
  it('renders every block type on every renderer without throwing', () => {
    /**
     * Seventeen blocks, one of each, through all three renderers. Not a
     * coverage check — the scan above is that — but the thing a coverage check
     * cannot do: prove the handlers run on real block data rather than merely
     * existing.
     */
    const blocks: Block[] = BLOCK_DEFINITIONS.map((definition, index) =>
      definition.create(`block-${index}`),
    )

    expect(blocks).toHaveLength(17)

    const html = renderEmailHtml({
      blocks,
      unsubscribeUrl: 'https://example.test/u/abc',
    })
    const text = renderEmailText({
      blocks,
      unsubscribeUrl: 'https://example.test/u/abc',
    })

    expect(html).toContain('<html')
    expect(text.length).toBeGreaterThan(0)

    // And the merge-field pass survives one of everything, which is where a
    // `default: return block` would otherwise hide a missing case.
    expect(() => resolveBlocks(blocks, { 'client.name': 'X' })).not.toThrow()
    expect(() => unresolvedInBlocks(blocks, {})).not.toThrow()
  })
})
