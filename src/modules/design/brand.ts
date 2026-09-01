/**
 * The brand kit a document gets when its company has not made one (Phase 79).
 *
 * ## Six answers to one question
 *
 * "What colour is a proposal from a company that never opened the Design
 * Center" was written out six times:
 *
 * | Where | As |
 * | --- | --- |
 * | `components/design/document-render` | `DEFAULT_BRAND` |
 * | `modules/pdf/service` | `DEFAULT_BRAND`, a second one |
 * | `modules/pdf/invoice` | `INVOICE_BRAND`, a third |
 * | `app/studio/studio-workspace` | six `??` fallbacks in a form |
 * | `db/schema/studio` | five column defaults |
 * | `modules/pdf/layout` | **three hand-converted float triples** |
 *
 * The last one is the interesting copy. PDF colour operators take components
 * in 0–1, so somebody converted the hex by hand:
 *
 *     parseColor(input.brand.textColor,    { r: 0.06, g: 0.09, b: 0.16 })
 *     parseColor(input.brand.mutedColor,   { r: 0.39, g: 0.45, b: 0.55 })
 *     parseColor(input.brand.primaryColor, { r: 0.05, g: 0.43, b: 0.38 })
 *
 * All three are wrong. `#0f172a` is `0.0588 0.0902 0.1647`, not `…0.16`;
 * `#64748b` is `0.392 0.455 0.545`; `#0d6e60` is `0.051 0.431 0.376`, and
 * `0.38` reads back as `#0d6e61`.
 *
 * That fallback fires when a stored brand colour cannot be parsed — which
 * looked unreachable, and was not: `isHexColor`, the guard on the only path a
 * brand colour takes into the database, accepts **three-digit** hex, and
 * `parseColor` only took six. So a company whose kit said `#fff` got a white
 * document on screen and a document in these three drifted colours on paper.
 * Phase 79 taught `parseColor` the same spelling, and the fallback is now the
 * same constant as everything else rather than a fourth copy of it.
 *
 * There is one answer, and `parseColor` does the conversion, which is what it
 * was written for.
 *
 * ## Why it is still teal
 *
 * `#0d6e60` is the palette this application itself stopped using at Phase 70,
 * and it is tempting to repaint it. It is deliberately left alone: these are
 * the colours of **the customer's** letterhead, not our chrome, and changing
 * the default would repaint the proposals and invoices of every company that
 * never chose one — a visible change to somebody else's documents, made to
 * tidy a codebase. What this phase fixes is that it is written once.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * Everything a document needs to be painted.
 *
 * `surfaceColor` is on the kit but not on `pdf/layout`'s `BrandTokens`, which
 * is right rather than an omission: paper is the colour of paper, and a PDF
 * that filled its page with a surface colour would waste the ink of anybody
 * who printed it.
 */
export type BrandKit = {
  primaryColor: string
  accentColor: string
  textColor: string
  mutedColor: string
  surfaceColor: string
  headingFont: string
  bodyFont: string
  baseSizePt: number
}

export const DEFAULT_BRAND_KIT: BrandKit = {
  primaryColor: '#0d6e60',
  accentColor: '#0f766e',
  textColor: '#0f172a',
  mutedColor: '#64748b',
  surfaceColor: '#ffffff',
  headingFont: 'Georgia, serif',
  bodyFont: 'system-ui, sans-serif',
  baseSizePt: 11,
}
