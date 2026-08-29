/**
 * What this product is called and what it looks like (Phase 73).
 *
 * ## One thing, five answers
 *
 * The application named itself in five places and no two the same way. The
 * rail drew a lime square with the letters "A+" typed into it, a wordmark and
 * a bordered badge. The login page had `<h1>Accountrix Plus</h1>`. The reset
 * page had it as a `<p>`. The marketing header and footer each had a `<span>`.
 * Five answers to "what is this called and how does it look", which is the
 * defect this codebase keeps removing — Phase 70 removed it from the words for
 * corrections, and this removes it from the product's own name.
 *
 * ## The stale one
 *
 * Worse than a duplicate: a wrong one. `public/icons/icon.svg` was a **teal**
 * `#0d6e60` square with a white letter A, and `manifest.webmanifest` painted
 * its splash screen the same teal. Both predate Phase 70's retheme, so the
 * icon on somebody's home screen and the colour behind the app while it
 * loaded belonged to a design this application stopped using thirty phases
 * ago. Nobody noticed because a favicon is the one part of an interface its
 * builders never look at.
 *
 * So the mark is drawn from these constants, and the icon route and the web
 * manifest are generated from them too — three things that used to be able to
 * disagree, and now cannot.
 *
 * Nothing here touches the database or the clock.
 */

/** The product, in the two halves it is written in. */
export const BRAND = {
  name: 'Accountrix',
  /** Set in its own badge rather than run on: "Accountrix PLUS", not "Plus". */
  suffix: 'PLUS',
  /** Both together, for a page title or an email subject. */
  full: 'Accountrix Plus',
} as const

/**
 * The mark's colours.
 *
 * The same values as the `--brand`, `--ink` and `--chrome-muted` tokens in
 * `globals.css`. Repeated here as hex rather than read from CSS because these
 * are also written into a `.svg` served to a browser tab and a `.webmanifest`
 * read by an operating system, neither of which has a stylesheet — and a
 * favicon that resolved a CSS variable would render as nothing at all.
 */
export const MARK = {
  /** The lime ground. */
  ground: '#D6F24E',
  /** The A. Near-black rather than black: the same ink the workspace uses. */
  letter: '#0D1117',
  /** The plus, a step back from the letter so the A leads. */
  plus: '#98A2B0',
  /** Proportional to the side, so the mark scales without redrawing. */
  radiusRatio: 0.26,
} as const

/**
 * The mark as a standalone SVG document.
 *
 * A string rather than a component because two of its three uses are not
 * React: the icon route serves it as a file, and the PNG sizes in the web
 * manifest are rendered from it. The React logo draws the same geometry from
 * `MARK_PATHS` below, so there is one shape and two ways to reach it.
 */
export function markSvg(size = 100): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">`,
    `<rect width="100" height="100" rx="${(100 * MARK.radiusRatio).toFixed(1)}" fill="${MARK.ground}"/>`,
    `<path d="${MARK_PATHS.letter}" fill="${MARK.letter}" fill-rule="evenodd"/>`,
    `<path d="${MARK_PATHS.plus}" fill="${MARK.plus}"/>`,
    `</svg>`,
  ].join('')
}

/**
 * The two shapes inside the mark, on a 100-unit grid.
 *
 * The A is one path with its counter cut out by `evenodd`, so the lime shows
 * through the triangle rather than the mark needing a second fill in the
 * ground colour — which would go wrong the moment anything sat behind it.
 */
export const MARK_PATHS = {
  letter:
    'M43.5 21h13l19 58h-13.5l-3.5-11.5h-17L38 79H24.5zM50 36.5l-5 19h10z',
  plus: 'M69 30h8.5v9H86v8.5h-8.5V56H69v-8.5h-8.5V39H69z',
} as const

/**
 * What a maskable icon needs: the safe area an operating system may crop to.
 *
 * Android crops a maskable icon to whatever shape the launcher uses — a
 * circle, a squircle, a rounded square — and only the middle 80% is
 * guaranteed to survive. The mark is drawn inside that circle, on a full-bleed
 * lime ground, so a round launcher gets a lime disc with the A+ centred rather
 * than a rounded square with its corners shaved off.
 */
export function maskableSvg(size = 512): string {
  const inset = 10 // per cent, each side — the 80% safe area
  const scale = (100 - inset * 2) / 100

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">`,
    `<rect width="100" height="100" fill="${MARK.ground}"/>`,
    `<g transform="translate(${inset} ${inset}) scale(${scale})">`,
    `<path d="${MARK_PATHS.letter}" fill="${MARK.letter}" fill-rule="evenodd"/>`,
    `<path d="${MARK_PATHS.plus}" fill="${MARK.plus}"/>`,
    `</g>`,
    `</svg>`,
  ].join('')
}
