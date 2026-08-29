import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND, MARK, MARK_PATHS, markSvg, maskableSvg } from '@/modules/brand/identity'

/**
 * The mark, and the three places it has to agree with itself (Phase 73).
 *
 * Pure. No database, no clock.
 */

describe('what the product is called', () => {
  it('keeps the name and the suffix apart', () => {
    expect(BRAND.name).toBe('Accountrix')
    expect(BRAND.suffix).toBe('PLUS')
  })

  /** So an email subject and a page title cannot spell it differently. */
  it('spells the two together one way', () => {
    expect(BRAND.full).toBe(`${BRAND.name} Plus`)
  })
})

describe('the mark', () => {
  it('is drawn on the lime the workspace calls the brand', () => {
    // `--brand: 214 242 78` in globals.css.
    expect(MARK.ground.toUpperCase()).toBe('#D6F24E')
  })

  it('cuts the A’s counter out rather than filling it back in', () => {
    expect(markSvg()).toContain('fill-rule="evenodd"')
    // Two subpaths: the outer letter, then the triangle inside it.
    expect(MARK_PATHS.letter.match(/M/g)).toHaveLength(2)
  })

  it('scales without being redrawn', () => {
    expect(markSvg(512)).toContain('width="512"')
    expect(markSvg(512)).toContain('viewBox="0 0 100 100"')
  })

  /**
   * Android crops a maskable icon to the launcher's shape and only the middle
   * 80% is guaranteed to survive, so this one is full-bleed with the mark
   * inset — a round launcher gets a lime disc, not a shaved square.
   */
  it('gives the maskable icon a full-bleed ground and an inset mark', () => {
    const svg = maskableSvg()
    expect(svg).toContain(`<rect width="100" height="100" fill="${MARK.ground}"/>`)
    expect(svg).toContain('translate(10 10) scale(0.8)')
    expect(svg).not.toContain('rx=')
  })
})

/**
 * The icon script is a plain `.mjs` that cannot import a TypeScript module
 * behind a path alias, so it repeats these constants. That is the shape of
 * defect this codebase keeps removing, and the honest mitigation is a test
 * that fails the moment the two copies disagree — which is what stops the
 * home-screen icon drifting away from the mark again.
 */
describe('the renderer repeats the constants, and may not drift from them', () => {
  const script = readFileSync('scripts/render-brand-icons.mjs', 'utf8')

  it.each([
    ['GROUND', MARK.ground],
    ['LETTER_FILL', MARK.letter],
    ['PLUS_FILL', MARK.plus],
  ])('uses the same %s', (name, value) => {
    expect(script).toContain(`const ${name} = '${value}'`)
  })

  it('uses the same two paths', () => {
    expect(script).toContain(`const LETTER = '${MARK_PATHS.letter}'`)
    expect(script).toContain(`const PLUS = '${MARK_PATHS.plus}'`)
  })

  it('uses the same corner radius', () => {
    expect(script).toContain(`const RADIUS = ${100 * MARK.radiusRatio}`)
  })
})

/**
 * The icon and the manifest were a **teal** `#0d6e60` — the palette this
 * application stopped using at Phase 70 — because a favicon is the one part of
 * an interface its builders never look at.
 */
describe('the assets on disk', () => {
  it('serves the mark, not the colour scheme from thirty phases ago', () => {
    const icon = readFileSync('public/icons/icon.svg', 'utf8')

    expect(icon).toContain(MARK.ground)
    expect(icon).toContain(MARK_PATHS.letter)
    expect(icon.toLowerCase()).not.toContain('0d6e60')
  })

  it('paints the splash screen in the brand rather than the old teal', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'))

    expect(manifest.background_color).toBe(MARK.ground)
    expect(manifest.theme_color).toBe(MARK.letter)
    expect(manifest.name).toBe(BRAND.full)
  })
})
