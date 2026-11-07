import { describe, expect, it } from 'vitest'
import { BLOCK_DEFINITIONS, parseBlocks, validateBlocks, type Block } from '@/modules/design/blocks'
import {
  SHAPE_KINDS,
  SHAPE_PAINTS,
  describeShape,
  resolveShapePaint,
  shapeSvg,
  type ShapeBlock,
} from '@/modules/design/shapes'
import { readSvg } from '@/modules/design/svg'
import { renderDocumentPdf, type BrandTokens } from '@/modules/pdf/layout'
import { renderEmailHtml } from '@/modules/marketing/render-email'

/**
 * A shape somebody can place (Phase 193, §7's *vector primitives*).
 *
 * ## What the row said, and what was actually missing
 *
 * ADR 0173: *"No lines, rectangles, ellipses, paths, fills, strokes,
 * gradients, shadows, corner controls or transforms. The engine is 18 block
 * types."* True when written. Measured again in Phase 193, as ADR 0192 said
 * to, it names **ten** of §7's **thirteen** — omitting `text`, `opacity` and
 * `reusable components`, two of which are built — and most of the ten it does
 * name are now drawable: `pdf/vector.ts` puts rectangles, ellipses, lines,
 * paths, fills, strokes, corner radii and transforms on paper, and the page
 * renders the same markup, because an imported SVG is exactly those things.
 *
 * What was missing is a way to **place** one without going to a vector editor
 * and uploading a file. That is this block.
 *
 * ## The claim these tests are mostly about
 *
 * A shape is **generated, never authored as markup**: the block holds
 * parameters and `shapeSvg` turns them into SVG inside the subset
 * `design/svg.ts` already allows. So there is no new trust boundary and — the
 * part that matters — no second renderer. If the generator ever stepped
 * outside that subset, `page.vector` would draw nothing while the page drew
 * the shape, which is the two-documents defect the shared subset exists to
 * prevent. The first test below walks the parameter space asserting it
 * cannot.
 */

const BRAND: BrandTokens = {
  primaryColor: '#1b4965',
  accentColor: '#f4a460',
  textColor: '#111111',
  mutedColor: '#9bb2b2',
  headingFont: 'Georgia, serif',
  bodyFont: 'Helvetica, sans-serif',
  baseSizePt: 11,
}

function shape(over: Record<string, unknown> = {}): ShapeBlock {
  return parseBlocks([{ id: 's', type: 'shape', ...over }])[0] as ShapeBlock
}

const BOX = { width: 400, height: 80 }

// ---------------------------------------------------------------------------

describe('the generator cannot leave the subset both renderers share', () => {
  /*
    Every combination of kind and paint, at the edges of each number. Not a
    sample: the parameter space is small enough to enumerate, and the property
    is the one thing holding the page and the PDF together.
  */
  const cases: ShapeBlock[] = []
  for (const kind of SHAPE_KINDS) {
    for (const fill of SHAPE_PAINTS) {
      for (const stroke of SHAPE_PAINTS) {
        for (const strokeWidthPt of [0, 0.5, 1, 24]) {
          for (const cornerRadiusPt of [0, 1, 200]) {
            cases.push(shape({ shape: kind, fill, stroke, strokeWidthPt, cornerRadiusPt }))
          }
        }
      }
    }
  }

  it(`produces markup the reader accepts, in all ${cases.length} combinations`, () => {
    const refused: string[] = []

    for (const block of cases) {
      for (const box of [BOX, { width: 1, height: 1 }, { width: 600, height: 2 }]) {
        const svg = shapeSvg(block, BRAND, box)
        if (svg === '') continue

        const read = readSvg(svg)
        if ('refusal' in read) {
          refused.push(
            `${block.shape} fill=${block.fill} stroke=${block.stroke} ` +
              `w=${block.strokeWidthPt} r=${block.cornerRadiusPt} ` +
              `box=${box.width}x${box.height}: ${read.refusal.reason}`,
          )
        }
      }
    }

    expect(refused.join('\n')).toBe('')
  })

  it('had something to check, so an empty answer means something', () => {
    // Phase 126. `refused` being empty is only reassuring if the loop ran.
    expect(cases.length).toBeGreaterThan(200)
    expect(shapeSvg(cases[0], BRAND, BOX)).toContain('<svg')
  })
})

describe('each primitive', () => {
  it('draws a rectangle, and keeps its stroke inside the box', () => {
    const svg = shapeSvg(shape({ shape: 'rectangle', stroke: 'text', strokeWidthPt: 4 }), BRAND, BOX)

    /*
      A stroke straddles the path, so a rectangle drawn on the box's edge
      loses its outer half to the viewBox — a stroke of half the width on
      three sides and none on the fourth, which nobody notices until it is
      printed. Inset by half, so the drawn edge is the box's edge.
    */
    expect(svg).toContain('<rect x="2" y="2" width="396" height="76"')
    expect(svg).toContain('stroke-width="4"')
  })

  it('draws an ellipse that fills its box rather than a circle', () => {
    const svg = shapeSvg(shape({ shape: 'ellipse' }), BRAND, BOX)

    // A shape is the one drawing here that should *not* keep an aspect ratio:
    // a panel is as wide as the author made it.
    expect(svg).toContain('<ellipse cx="200" cy="40" rx="200" ry="40"')
  })

  it('draws a line at the middle of its box, ignoring fill', () => {
    const svg = shapeSvg(
      shape({ shape: 'line', fill: 'primary', stroke: 'accent', strokeWidthPt: 3 }),
      BRAND,
      BOX,
    )

    // `heightPt` is the space a line occupies, not its thickness — the same
    // meaning `spacer` gives the field.
    expect(svg).toContain('<line x1="0" y1="40" x2="400" y2="40"')
    expect(svg).toContain(`stroke="${BRAND.accentColor}"`)
    expect(svg).not.toContain('fill=')
  })

  it('still draws a line nobody gave a colour', () => {
    const svg = shapeSvg(shape({ shape: 'line', stroke: 'none' }), BRAND, BOX)

    // A line with no stroke is invisible, which is never what somebody placing
    // one meant. Falls back rather than drawing nothing.
    expect(svg).toContain(`stroke="${BRAND.textColor}"`)
  })

  it('clamps a corner radius to half the side', () => {
    const svg = shapeSvg(
      shape({ shape: 'rectangle', cornerRadiusPt: 200 }),
      BRAND,
      { width: 40, height: 20 },
    )

    // `rx="200"` on a 40-wide rectangle draws a shape that turns inside out,
    // which is why the spec requires the clamp.
    expect(svg).toContain('rx="10" ry="10"')
  })

  it('draws nothing at all for an empty box', () => {
    expect(shapeSvg(shape(), BRAND, { width: 0, height: 40 })).toBe('')
    expect(shapeSvg(shape(), BRAND, { width: 400, height: 0 })).toBe('')
  })
})

describe('colour is a brand role', () => {
  it('resolves each role to the kit, so a document restyles', () => {
    /*
      **No block in this engine carries a colour**, and this one does not
      break that. ADR 0004's fifth decision is that brand values are custom
      properties so one document renders under a different kit without
      touching its content — a hex here would be content that outlives the
      kit.
    */
    expect(resolveShapePaint('primary', BRAND)).toBe(BRAND.primaryColor)
    expect(resolveShapePaint('accent', BRAND)).toBe(BRAND.accentColor)
    expect(resolveShapePaint('text', BRAND)).toBe(BRAND.textColor)
    expect(resolveShapePaint('muted', BRAND)).toBe(BRAND.mutedColor)
    expect(resolveShapePaint('none', BRAND)).toBe('none')
  })

  it('takes no colour of its own, at all', () => {
    /*
      A hex does not fall back to the default — the block does not parse, and
      `parseBlocks` drops it. Stronger than a fallback and consistent with
      every other enum in the union: the read path is forgiving about a
      malformed block because *"a document that fails to render is worse than
      one missing a block"*, and a shape nobody can paint is malformed.

      Worth asserting rather than assuming, because I assumed a fallback when
      writing this and the test said otherwise.
    */
    expect(parseBlocks([{ id: 's', type: 'shape', fill: '#ff0000' }])).toEqual([])

    // And the save path refuses it loudly rather than silently, which is the
    // other half of that bargain.
    expect(validateBlocks([{ id: 's', type: 'shape', fill: '#ff0000' }]).errors).toHaveLength(1)
  })

  it('does not offer the page colour, for a reason already written down', () => {
    /*
      `brand.ts`: `surfaceColor` is on the kit and not on the PDF's tokens,
      *"which is right rather than an omission: paper is the colour of paper,
      and a PDF that filled its page with a surface colour would waste the ink
      of anybody who printed it."*

      Offering it would have meant reaching round that, and would buy nothing:
      blocks here flow rather than overlap, so a shape the colour of the page
      is invisible by construction.
    */
    expect(SHAPE_PAINTS).not.toContain('surface')
  })
})

describe('the surfaces draw the same shape', () => {
  const blocks = (): Block[] =>
    parseBlocks([
      { id: 'r', type: 'shape', shape: 'rectangle', fill: 'primary', widthPercent: 60, align: 'center', heightPt: 40 },
      { id: 'l', type: 'shape', shape: 'line', stroke: 'accent', strokeWidthPt: 3, widthPercent: 40, align: 'right', heightPt: 16 },
    ])

  it('puts path operators in the PDF rather than a picture', () => {
    const pdf = renderDocumentPdf({
      blocks: blocks(),
      brand: BRAND,
      merge: {},
      pageSize: 'letter',
      orientation: 'portrait',
      headerText: null,
      footerText: null,
      showPageNumbers: false,
      title: 'shapes',
      author: 'test',
      createdAt: new Date(0),
    }).toString('latin1')

    /*
      A panel is a rectangle in the file rather than a picture of one, which
      is what `page.vector` buys: resolution-independent, and no XObject.
    */
    expect(pdf).toContain(' re')
    expect(pdf).toMatch(/0\.106 0\.286 0\.396 rg/)
    expect(pdf).not.toContain('/Subtype /Image')
  })

  it('honours alignment and width in the email too', () => {
    const html = renderEmailHtml({
      blocks: blocks(),
      unsubscribeUrl: 'https://example.test/u/a',
      brand: { ...BRAND, bodyFont: 'Arial', headingFont: 'Georgia' },
    })

    /*
      The one place this engine renders a block differently rather than from
      the shared markup, and the medium's doing: Gmail strips inline SVG, so a
      shape drawn that way is a gap in the message for most of a list. A
      rectangle *is* a background colour with a border radius.

      Both assertions here were false in the first version and were found by
      rendering the three surfaces side by side and looking: a centred shape
      sat left, and a 40% line ran the full width.
    */
    expect(html).toContain('text-align:center')
    expect(html).toContain('text-align:right')
    expect(html).toContain('width:60%')
    expect(html).toContain('width:40%')
    expect(html).toContain(BRAND.accentColor)
  })

  it('names itself in the designer list', () => {
    expect(describeShape(shape({ shape: 'ellipse' }))).toBe('Ellipse')
    expect(describeShape(shape({ fill: 'none', stroke: 'none' }))).toBe('Rectangle — no paint')
  })
})

describe('what an older document sees', () => {
  it('is unaffected, because a shape is a new type and not a new field', () => {
    /*
      Unlike Phase 191's `hidden`/`locked`, which every stored block grew.
      Adding a *type* costs documents written before it nothing at all — which
      is ADR 0004's claim about the union being open, and is why the engine
      has absorbed four new block types since Phase 5 without a migration.
    */
    const old = parseBlocks([
      { id: 'a', type: 'text', text: 'Written long ago.', align: 'left' },
    ])

    expect(old).toHaveLength(1)
    expect(old[0].type).toBe('text')
  })

  it('is in the palette for both kinds of document', () => {
    const definition = BLOCK_DEFINITIONS.find((entry) => entry.type === 'shape')

    // A marketing flyer wants a coloured band at least as much as a proposal
    // does, and `kinds` is what decides — see ADR 0004's third decision.
    expect(definition?.kinds).toEqual(['proposal', 'marketing'])
  })
})

describe('what this does not do', () => {
  it('has no gradient, no shadow and no arbitrary path', () => {
    /*
      Three of §7's thirteen, and each is refused somewhere with a reason
      rather than missing by accident:

       - **gradients** — `design/svg.ts` resolves `url(#g)` to null, because a
         paint server is a PDF shading dictionary and that is a different
         piece of work from a fill (ADR 0190).
       - **opacity** — refused above 0 and below 1, because group opacity
         composites once and per-element alpha does not, and the difference is
         invisible until a logo with overlapping shapes prints wrong.
       - **paths** — drawable, and not authorable here: a path needs a canvas
         to draw it on, which is ADR 0004's `canvas` block and not this one.

      Asserted so the next reader meets the decisions rather than the gaps.
    */
    expect(SHAPE_KINDS).toEqual(['rectangle', 'ellipse', 'line'])

    const gradient = readSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<rect width="10" height="10" fill="url(#g)"/></svg>',
    )
    expect('refusal' in gradient).toBe(true)
  })

  it('cannot be rotated, because a block stack has nowhere to rotate it', () => {
    /*
      `pdf/vector.ts` applies a transform and `design/svg.ts` reads one, so the
      renderers could. A block in a flowing stack has a width and a height and
      no position, and a rotated rectangle's bounding box is not its height —
      so the engine would have to reserve space it cannot compute. That is a
      canvas's job.
    */
    expect(Object.keys(shape())).not.toContain('rotation')
  })
})
