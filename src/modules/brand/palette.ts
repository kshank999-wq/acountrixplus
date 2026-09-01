/**
 * The application's own colours, as data (Phase 79).
 *
 * ## Why this exists at all
 *
 * `globals.css` is the palette. Every screen in the product is painted from
 * the custom properties in its `:root` block, and Phase 70's retheme reached
 * forty screens without rewriting any of them precisely because they all speak
 * in those names.
 *
 * But three surfaces cannot read a stylesheet:
 *
 *  - `viewport.themeColor` in `app/layout`, which Next turns into a
 *    `<meta name="theme-color">` — a browser reads it before any CSS.
 *  - `public/offline.html`, served by the service worker when the device has
 *    nothing cached. No script, no stylesheet, no font; everything it needs is
 *    in its own bytes.
 *  - `manifest.webmanifest`, read by an operating system.
 *
 * Each of them had the colours written out as literals, and each of them was
 * still the **teal** this application stopped using at Phase 70 — three years
 * of retheme reaching every screen and none of the frames around them.
 *
 * ## The rule
 *
 * `globals.css` stays the source. This file is a *mirror* of it, and
 * `tests/palette.test.ts` reads the stylesheet and fails if any value here
 * disagrees. That is what makes the copy safe: a colour can be written in two
 * places as long as one of them cannot silently be wrong.
 *
 * The same trick `modules/brand/identity` uses for the mark, for the same
 * reason — a favicon that resolved a CSS variable would render as nothing at
 * all.
 *
 * Nothing here touches the database or the clock.
 */

/** The two schemes `globals.css` defines. Nothing else is themed. */
export type Scheme = 'light' | 'dark'

/**
 * The token names, spelled exactly as the CSS custom properties are.
 *
 * Kebab-case rather than the camelCase the rest of the codebase writes,
 * because a translation table between `brandInk` and `--brand-ink` would be
 * one more thing that can be wrong — and the test compares these keys against
 * the stylesheet directly.
 */
export type ColorName =
  | 'canvas'
  | 'surface'
  | 'raised'
  | 'line'
  | 'ink'
  | 'muted'
  | 'faint'
  | 'brand'
  | 'brand-ink'
  | 'action'
  | 'action-ink'
  | 'positive'
  | 'negative'
  | 'warning'
  | 'chrome'
  | 'chrome-raised'
  | 'chrome-line'
  | 'chrome-ink'
  | 'chrome-muted'

/**
 * Every token, in both schemes, as hex.
 *
 * Hex rather than the `R G B` triplets the stylesheet writes, because every
 * consumer of this file is somewhere hex is the only accepted spelling: a
 * `<meta>` tag, a web manifest, a plain HTML page. `rgbTriplet` converts back
 * for the one caller that needs to compare against the CSS.
 */
export const PALETTE: Record<Scheme, Record<ColorName, string>> = {
  light: {
    canvas: '#FAFBFC',
    surface: '#FFFFFF',
    raised: '#F1F3F6',
    line: '#E4E7EC',
    ink: '#0D1117',
    muted: '#5B6672',
    faint: '#8A94A1',
    brand: '#D6F24E',
    'brand-ink': '#0D1117',
    action: '#1F5FD9',
    'action-ink': '#FFFFFF',
    positive: '#0F7B57',
    negative: '#D1490B',
    warning: '#B45309',
    chrome: '#0D1117',
    'chrome-raised': '#1B222C',
    'chrome-line': '#3A4432',
    'chrome-ink': '#FFFFFF',
    'chrome-muted': '#98A2B0',
  },
  dark: {
    canvas: '#0D1117',
    surface: '#14181F',
    raised: '#1B222C',
    line: '#2A323E',
    ink: '#F4F6F8',
    muted: '#A8B1BD',
    faint: '#7A8491',
    brand: '#D6F24E',
    'brand-ink': '#0D1117',
    action: '#6096FF',
    'action-ink': '#080E1A',
    positive: '#34C791',
    negative: '#FB9260',
    warning: '#FBBF24',
    chrome: '#090C11',
    'chrome-raised': '#14181F',
    'chrome-line': '#3A4432',
    'chrome-ink': '#FFFFFF',
    'chrome-muted': '#98A2B0',
  },
}

/** One colour, named. */
export function color(name: ColorName, scheme: Scheme = 'light'): string {
  return PALETTE[scheme][name]
}

/**
 * `#FAFBFC` → `250 251 252`.
 *
 * The form Tailwind needs, because `rgb(var(--canvas) / <alpha-value>)` is what
 * lets `bg-surface/95` work at all — a hex custom property cannot take an
 * opacity modifier. Used by the test to compare this file against the CSS, in
 * the CSS's own spelling rather than a normalised one.
 */
export function rgbTriplet(hex: string): string {
  const value = parseHex(hex)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].join(' ')
}

/** `250 251 252` → `#FAFBFC`. The other direction, for reading a stylesheet. */
export function fromRgbTriplet(triplet: string): string {
  const parts = triplet.trim().split(/\s+/)
  if (parts.length !== 3) throw new Error(`Not an RGB triplet: ${triplet}`)

  return `#${parts
    .map((part) => {
      const number = Number(part)
      if (!Number.isInteger(number) || number < 0 || number > 255) {
        throw new Error(`Not an RGB triplet: ${triplet}`)
      }
      return number.toString(16).padStart(2, '0')
    })
    .join('')}`.toUpperCase()
}

function parseHex(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`Not a six-digit hex colour: ${hex}`)
  return parseInt(match[1], 16)
}

/**
 * What Next writes into `<meta name="theme-color">`.
 *
 * The **chrome**, not the canvas. A browser paints this behind its address bar
 * and an installed app paints it behind the status bar, and in this design that
 * band is continuous with the navigation rail — which is near-black in both
 * schemes, and deliberately does not follow the workspace theme.
 *
 * The shape is Next's `Viewport['themeColor']`, kept structural rather than
 * imported so that this module stays framework-free and testable on its own.
 */
export function themeColorMeta(): Array<{ media: string; color: string }> {
  return [
    { media: '(prefers-color-scheme: light)', color: PALETTE.light.chrome },
    { media: '(prefers-color-scheme: dark)', color: PALETTE.dark.chrome },
  ]
}
