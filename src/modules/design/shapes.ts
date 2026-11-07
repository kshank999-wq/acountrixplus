/**
 * Vector primitives, in the idiom this engine has (Phase 193, spec §7).
 *
 * ## What the audit row asked for, and what was actually missing
 *
 * ADR 0173's row reads *"No lines, rectangles, ellipses, paths, fills,
 * strokes, gradients, shadows, corner controls or transforms. The engine is 18
 * block types."* Measured against the tree in Phase 193, most of that is wrong
 * now and was right when written: `pdf/vector.ts` draws rectangles, ellipses,
 * lines, paths, fills, strokes, corner radii and transforms on paper, and the
 * page renders the same markup, because an imported SVG is exactly those
 * things.
 *
 * What is missing is not a renderer. It is a way for an author to **place**
 * one without going to a vector editor and uploading a file.
 *
 * ## So a shape is generated, never authored as markup
 *
 * A `shape` block holds parameters — which primitive, what colour, how tall —
 * and this module turns them into SVG. The author never writes markup, which
 * is the whole reason this is cheap: there is no new trust boundary, no second
 * sanitiser, and no second renderer. Both surfaces draw the string this
 * function returns.
 *
 * The output is deliberately inside `design/svg.ts`'s allowlist, and a test
 * asserts that across the parameter space rather than this module promising
 * it. If it ever fell outside, `page.vector` would draw nothing while the page
 * drew the shape — the two-documents defect, which is what the shared subset
 * exists to prevent.
 *
 * ## Colour is a brand role, not a value
 *
 * **No block in this engine has ever carried a colour**, and this one does not
 * break that. ADR 0004's fifth decision is that brand values are CSS custom
 * properties so *"one document renders under a different brand kit without
 * touching its content"* — a hex in a block is content that outlives the brand
 * kit, and a document full of them is a document that cannot be restyled.
 *
 * It also avoids a validation surface with a history. `style-values.ts` exists
 * because a colour reaching a `style` attribute was safe only by virtue of a
 * guard three modules away, asserted by nothing. A role resolves to a value
 * that has already been through that check.
 */

import type { Block } from './blocks'

/** The primitives on offer, and why these three. */
export const SHAPE_KINDS = ['rectangle', 'ellipse', 'line'] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

/**
 * Where a shape's colour comes from.
 *
 * Four brand roles, plus `none`. `none` is a real answer rather than an
 * absence: a rectangle with no fill and a stroke is an outline, which is most
 * of what a panel around a figure wants to be.
 *
 * **`surfaceColor` is deliberately not one of them**, and the reason was
 * already written down. `brand.ts` records that the page background colour is
 * on the kit and not on the PDF's tokens, *"which is right rather than an
 * omission: paper is the colour of paper, and a PDF that filled its page with
 * a surface colour would waste the ink of anybody who printed it."*
 *
 * Offering it here would have meant either reaching round that decision or
 * painting a shape a colour the PDF has no value for. And it would buy
 * nothing: blocks in this engine flow rather than overlap, so a shape the
 * colour of the page is invisible by construction — there is nothing beneath
 * it to knock out.
 */
export const SHAPE_PAINTS = ['primary', 'accent', 'text', 'muted', 'none'] as const
export type ShapePaint = (typeof SHAPE_PAINTS)[number]

export type ShapeBlock = Extract<Block, { type: 'shape' }>

/**
 * The resolved brand colours a shape can be painted with.
 *
 * Exactly the four both renderers hold. The PDF's `BrandTokens` and the page's
 * differ by `surfaceColor`, and this type is the intersection rather than
 * either of them — so a shape cannot be given a colour one surface could not
 * resolve.
 */
export type ShapeColors = {
  primaryColor: string
  accentColor: string
  textColor: string
  mutedColor: string
}

export function resolveShapePaint(paint: ShapePaint, colors: ShapeColors): string {
  switch (paint) {
    case 'primary':
      return colors.primaryColor
    case 'accent':
      return colors.accentColor
    case 'text':
      return colors.textColor
    case 'muted':
      return colors.mutedColor
    case 'none':
      return 'none'
  }
}

/**
 * A shape as SVG, in the subset both renderers already draw.
 *
 * `width` and `height` are the box the caller has worked out — a percentage of
 * the content width on one surface and points on the other — and the markup is
 * written in those same units, so the `viewBox` is the box and nothing scales.
 * A shape is the one drawing in this engine that should *not* keep an aspect
 * ratio: a panel is as wide as the author made it.
 *
 * The stroke is inset by half its width. A stroke in SVG straddles the path,
 * so a rectangle drawn on the box's edge loses its outer half to the viewBox —
 * which looks like a stroke of half the width on three sides and none on the
 * fourth, and is the kind of thing nobody notices until it is printed.
 */
export function shapeSvg(
  block: ShapeBlock,
  colors: ShapeColors,
  box: { width: number; height: number },
): string {
  const width = round(box.width)
  const height = round(box.height)
  if (width <= 0 || height <= 0) return ''

  const fill = resolveShapePaint(block.fill, colors)
  const stroke = resolveShapePaint(block.stroke, colors)
  const strokeWidth = stroke === 'none' ? 0 : block.strokeWidthPt
  const inset = strokeWidth / 2

  const paint =
    `fill="${fill}"` +
    (strokeWidth > 0 ? ` stroke="${stroke}" stroke-width="${round(strokeWidth)}"` : '')

  const body = (() => {
    switch (block.shape) {
      case 'rectangle': {
        const w = round(Math.max(0, width - strokeWidth))
        const h = round(Math.max(0, height - strokeWidth))
        // Clamped to half the side, as the SVG spec requires: `rx="50"` on a
        // 10-wide rectangle draws a shape that turns inside out.
        const r = round(Math.min(block.cornerRadiusPt, w / 2, h / 2))
        const radius = r > 0 ? ` rx="${r}" ry="${r}"` : ''
        return `<rect x="${round(inset)}" y="${round(inset)}" width="${w}" height="${h}"${radius} ${paint}/>`
      }

      case 'ellipse': {
        const rx = round(Math.max(0, width / 2 - inset))
        const ry = round(Math.max(0, height / 2 - inset))
        return `<ellipse cx="${round(width / 2)}" cy="${round(height / 2)}" rx="${rx}" ry="${ry}" ${paint}/>`
      }

      case 'line': {
        /*
          A line is a stroke and nothing else, so it ignores `fill` and draws
          at the vertical centre of its box — which makes `heightPt` the space
          it occupies rather than its thickness, the same meaning `spacer`
          gives the field. A line with no stroke colour would be invisible, so
          it falls back to the text colour rather than drawing nothing.
        */
        const y = round(height / 2)
        const colour = stroke === 'none' ? colors.textColor : stroke
        const thickness = round(Math.max(0.5, block.strokeWidthPt))
        return (
          `<line x1="0" y1="${y}" x2="${width}" y2="${y}" ` +
          `stroke="${colour}" stroke-width="${thickness}" stroke-linecap="butt"/>`
        )
      }
    }
  })()

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${body}</svg>`
  )
}

/** Three decimals, matching the PDF writer's own rounding. */
function round(value: number): number {
  return Number(value.toFixed(3))
}

/** A short description for the designer's block list. */
export function describeShape(block: ShapeBlock): string {
  const kind = block.shape === 'rectangle' ? 'Rectangle' : block.shape === 'ellipse' ? 'Ellipse' : 'Line'
  return block.fill === 'none' && block.stroke === 'none' ? `${kind} — no paint` : kind
}
