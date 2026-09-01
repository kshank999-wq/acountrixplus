import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PALETTE,
  color,
  fromRgbTriplet,
  rgbTriplet,
  themeColorMeta,
  type ColorName,
  type Scheme,
} from '@/modules/brand/palette'
import { MARK } from '@/modules/brand/identity'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import { isHexColor } from '@/modules/design/style-values'
import { parseColor } from '@/modules/pdf/writer'

/** A colour nothing would ever choose, so "fell back" is unambiguous. */
const MISSED = { r: 0.123, g: 0.456, b: 0.789 }

/**
 * The colours written down twice (Phase 79).
 *
 * `globals.css` is the palette and always was. What this file exists for is
 * the surfaces that cannot read it — a `<meta>` tag, a web manifest, a page
 * served when the device is offline — which had the values written out as
 * literals and had all quietly stayed on the pre-Phase-70 teal.
 *
 * A copy is allowed here on one condition: that it cannot silently be wrong.
 * These are the assertions that buy that.
 */

const globalsCss = readFileSync('src/app/globals.css', 'utf8')
const offlineHtml = readFileSync('public/offline.html', 'utf8')
const studioSchema = readFileSync('src/db/schema/studio.ts', 'utf8')

/**
 * The custom properties declared in a file's nth `:root { … }` block.
 *
 * Deliberately dumb — a regex over a block, not a CSS parser. Both files this
 * reads write the light scheme in a bare `:root` and the dark one in a `:root`
 * nested inside `@media (prefers-color-scheme: dark)`, in that order, so
 * "block 0" and "block 1" are the two schemes. A parser would be a dependency
 * added to check a colour.
 */
function rootBlock(css: string, index: number): Record<string, string> {
  let at = -1
  for (let n = 0; n <= index; n += 1) at = css.indexOf(':root {', at + 1)
  if (at < 0) throw new Error(`No :root block ${index}`)

  const block = css.slice(at, css.indexOf('}', at))
  const out: Record<string, string> = {}

  for (const match of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    out[match[1]] = match[2].trim()
  }

  return out
}

const cssTokens: Record<Scheme, Record<string, string>> = {
  light: rootBlock(globalsCss, 0),
  dark: rootBlock(globalsCss, 1),
}

const offlineTokens: Record<Scheme, Record<string, string>> = {
  light: rootBlock(offlineHtml, 0),
  dark: rootBlock(offlineHtml, 1),
}

describe('the palette mirrors the stylesheet exactly', () => {
  const schemes: Scheme[] = ['light', 'dark']

  it.each(schemes)('names every %s token the stylesheet declares, and no others', (scheme) => {
    expect(Object.keys(PALETTE[scheme]).sort()).toEqual(Object.keys(cssTokens[scheme]).sort())
  })

  it.each(schemes)('gives the same value as the stylesheet for every %s token', (scheme) => {
    const asWritten = Object.fromEntries(
      Object.entries(PALETTE[scheme]).map(([name, hex]) => [name, rgbTriplet(hex)]),
    )

    // Compared in the CSS's own spelling rather than a normalised one, so a
    // failure reads as the two lines somebody would have to reconcile.
    expect(asWritten).toEqual(cssTokens[scheme])
  })

  /**
   * The stylesheet's own comment says the light and dark blocks are the same
   * set of names. Nothing checked it, and a token declared in one scheme only
   * is invisible until somebody switches theme.
   */
  it('themes every token in both directions', () => {
    expect(Object.keys(PALETTE.light)).toEqual(Object.keys(PALETTE.dark))
  })
})

describe('reading a colour', () => {
  it('converts hex to the triplet Tailwind needs, and back', () => {
    expect(rgbTriplet('#FAFBFC')).toBe('250 251 252')
    expect(fromRgbTriplet('250 251 252')).toBe('#FAFBFC')
    expect(fromRgbTriplet(rgbTriplet(PALETTE.dark.action))).toBe(PALETTE.dark.action)
  })

  it('accepts the spellings a stylesheet actually contains', () => {
    expect(rgbTriplet('#0d1117')).toBe('13 17 23')
    expect(rgbTriplet('0D1117')).toBe('13 17 23')
    expect(fromRgbTriplet('  13   17   23  ')).toBe('#0D1117')
  })

  it('refuses anything it cannot convert rather than guessing', () => {
    expect(() => rgbTriplet('#fff')).toThrow(/hex/i)
    expect(() => rgbTriplet('rebeccapurple')).toThrow(/hex/i)
    expect(() => fromRgbTriplet('250 251')).toThrow(/triplet/i)
    expect(() => fromRgbTriplet('250 251 300')).toThrow(/triplet/i)
  })

  it('defaults to the light scheme, which is the one bare :root declares', () => {
    expect(color('canvas')).toBe(PALETTE.light.canvas)
    expect(color('canvas', 'dark')).toBe(PALETTE.dark.canvas)
  })
})

/**
 * The `<meta name="theme-color">` Next writes from `viewport`.
 *
 * It was `#0d6e60` — a teal from thirty phases before the design this paints
 * the frame of. And it is the tag that wins: a browser prefers it to the
 * manifest's `theme_color` for the page it is on, so fixing the manifest at
 * Phase 73 fixed nothing anybody could see while the app was open.
 */
describe('the colour a browser paints around the app', () => {
  it('is the chrome, in both schemes', () => {
    expect(themeColorMeta()).toEqual([
      { media: '(prefers-color-scheme: light)', color: PALETTE.light.chrome },
      { media: '(prefers-color-scheme: dark)', color: PALETTE.dark.chrome },
    ])
  })

  it('is not the palette this application stopped using at Phase 70', () => {
    for (const entry of themeColorMeta()) {
      expect(entry.color.toLowerCase()).not.toBe('#0d6e60')
      expect(entry.color.toLowerCase()).not.toBe('#091420')
    }
  })

  it('is what the layout actually declares', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8')

    expect(layout).toContain('themeColor: themeColorMeta()')
    expect(layout).not.toMatch(/themeColor:\s*\[/)
  })

  /** The manifest is generated once and committed, so it is checked, not read. */
  it('agrees with the manifest an installed app reads instead', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'))

    expect(manifest.theme_color).toBe(PALETTE.light.chrome)
    expect(manifest.background_color).toBe(PALETTE.light.brand)
  })
})

/**
 * The mark's own doc comment claims its three colours are the `--brand`,
 * `--ink` and `--chrome-muted` tokens. It was true and nothing enforced it,
 * which is the same shape of promise the theme colour was making.
 */
describe('the mark is painted out of the palette it claims to be', () => {
  it('grounds in the brand, letters in the ink, and steps back to chrome-muted', () => {
    expect(MARK.ground).toBe(PALETTE.light.brand)
    expect(MARK.letter).toBe(PALETTE.light.ink)
    expect(MARK.plus).toBe(PALETTE.light['chrome-muted'])
  })
})

/**
 * The one page that has to render when nothing else can, so it inlines its
 * colours — and drifted for exactly that reason. It was the whole teal palette
 * as late as Phase 78.
 */
describe('the offline page', () => {
  const names: ColorName[] = ['canvas', 'ink', 'muted', 'action', 'action-ink']
  const schemes: Scheme[] = ['light', 'dark']

  it.each(schemes)('paints its %s scheme out of the palette', (scheme) => {
    // Its own copy has to be hex — there is no stylesheet to resolve a
    // triplet against — so the comparison converts rather than assuming.
    const declared = Object.fromEntries(
      names.map((name) => [name, offlineTokens[scheme][name]?.toUpperCase()]),
    )
    const expected = Object.fromEntries(names.map((name) => [name, PALETTE[scheme][name]]))

    expect(declared).toEqual(expected)
  })

  it('carries nothing from the palette that came before', () => {
    for (const dead of ['#0f172a', '#475569', '#f8fafc', '#e2e8f0', '#0d6e60', '#2dbfa5']) {
      expect(offlineHtml.toLowerCase()).not.toContain(dead)
    }
  })

  /**
   * It declared `--surface` and `--line` and used neither. A value nothing
   * reads is a value nothing can notice going stale — which is how the rest of
   * this block got to be nine phases out of date.
   */
  it('declares nothing it does not use', () => {
    const style = offlineHtml.slice(offlineHtml.indexOf('<style>'), offlineHtml.indexOf('</style>'))

    for (const match of style.matchAll(/--([a-z-]+):/g)) {
      expect(style).toContain(`var(--${match[1]})`)
    }
  })

  it('reaches for the action blue, since its ground is the light canvas', () => {
    // The lime is a dark-chrome colour in every artboard that uses it, and
    // `.btn-primary` — which is what a primary action on the workspace is —
    // is `bg-action text-action-ink`.
    expect(offlineHtml).toContain('background: var(--action);')
    expect(offlineHtml).not.toContain('var(--brand)')
  })
})

/**
 * The document default, which is a different question with a different answer:
 * these are the customer's letterhead colours, not the application's chrome.
 * It stays teal on purpose. What this phase fixed is that it stopped being
 * written down six times.
 */
describe('the brand kit a company gets before it chooses one', () => {
  it('is what the column defaults hand a new row', () => {
    const columns: Array<[keyof typeof DEFAULT_BRAND_KIT, string]> = [
      ['primaryColor', 'primary_color'],
      ['accentColor', 'accent_color'],
      ['textColor', 'text_color'],
      ['mutedColor', 'muted_color'],
      ['surfaceColor', 'surface_color'],
      ['headingFont', 'heading_font'],
      ['bodyFont', 'body_font'],
    ]

    for (const [key, column] of columns) {
      expect(studioSchema).toContain(`text('${column}').notNull().default('${DEFAULT_BRAND_KIT[key]}')`)
    }

    expect(studioSchema).toContain(
      `integer('base_size_pt').notNull().default(${DEFAULT_BRAND_KIT.baseSizePt})`,
    )
  })

  /**
   * The three float triples in `pdf/layout` were somebody's hand conversion of
   * these same hexes, and every one was a digit out. `parseColor` does the
   * conversion, and always could.
   */
  it('is converted by the writer rather than by hand', () => {
    const layout = readFileSync('src/modules/pdf/layout.ts', 'utf8')
    const call = /parseColor\(input\.brand\.\w+, \{[^}]*\}\)/

    expect(layout).not.toMatch(call)
    expect(layout).toContain('parseColor(DEFAULT_BRAND_KIT.textColor)')
  })
})

/**
 * Which made the drifted fallback reachable, and is the defect underneath the
 * duplicate: the form's guard and the writer's parser disagreed about what a
 * hex colour is, and the disagreement only showed up on paper.
 */
describe('one answer to what a hex colour is', () => {
  it('parses everything the Design Center will store', () => {
    for (const value of ['#fff', '#FFF', '#0d6e60', '#0D6E60']) {
      expect(isHexColor(value)).toBe(true)
      expect(parseColor(value, MISSED)).not.toEqual(MISSED)
    }
  })

  it('reads #abc as #aabbcc, which is what a browser does', () => {
    expect(parseColor('#abc')).toEqual(parseColor('#aabbcc'))
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1 })

    // Not a left-pad: `#abc` is not `#0a0b0c`.
    expect(parseColor('#abc')).not.toEqual(parseColor('#0a0b0c'))
  })

  it('still falls back on something that is not a colour at all', () => {
    for (const value of ['', 'rebeccapurple', '#12345', 'rgb(0,0,0)']) {
      expect(isHexColor(value)).toBe(false)
      expect(parseColor(value, MISSED)).toEqual(MISSED)
    }
  })

  it('is the only copy left in the source', () => {
    const written: string[] = []

    for (const file of [
      'src/components/design/document-render.tsx',
      'src/modules/pdf/service.ts',
      'src/modules/pdf/invoice.ts',
      'src/app/studio/studio-workspace.tsx',
    ]) {
      const source = readFileSync(file, 'utf8')
      // The comments in these files name the old value while explaining it, so
      // only an assignment counts as a copy.
      if (/:\s*'#0d6e60'/.test(source)) written.push(file)
    }

    expect(written).toEqual([])
  })
})
