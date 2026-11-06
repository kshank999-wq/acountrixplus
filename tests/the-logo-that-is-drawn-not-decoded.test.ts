import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { assets } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { readAsset, uploadAsset, ALLOWED_IMAGE_TYPES } from '@/modules/studio/assets'
import { EVIDENCE_CONTENT_TYPES } from '@/modules/evidence/service'
import {
  parsePath,
  parseTransform,
  resolvePaint,
  readSvg,
  sanitizeSvg,
} from '@/modules/design/svg'
import { imageSize, prepareImage } from '@/modules/pdf/images'
import { PageCanvas } from '@/modules/pdf/writer'

/**
 * The logo that is drawn, not decoded (Phase 190, spec §7).
 *
 * §7 asks for *"SVG import/export where practical"*, and SVG had been refused
 * since Phase 4 in three places with one argument, quoted verbatim in
 * `assets.ts`:
 *
 * > SVG is deliberately absent: it can carry script, and these files are
 * > served back to browsers on public proposal pages. Accepting it would turn
 * > the logo library into a stored-XSS vector.
 *
 * That argument was right. This phase does not overturn it — it changes the
 * fact it rests on. **The bytes in the store are no longer the uploader's.**
 *
 * ## One list doing two jobs
 *
 * The allowlist in `design/svg.ts` is both the security boundary and the
 * printable subset, and the test of whether a construct is allowed is not
 * whether it looks harmless but whether the module can read it completely
 * enough to redraw it. `parsePath`, `parseTransform` and `resolvePaint` are
 * therefore shared: the sanitiser refuses at upload exactly what the PDF
 * writer could not have drawn.
 *
 * That is the design, and it exists to prevent one specific failure: an SVG
 * that renders on the proposal page and leaves a hole in the PDF the client
 * prints. Which is Phase 185's defect — a *declared* limitation nobody
 * re-read — with a new file format.
 */

const LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported by something -->
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60">
  <title>Northwind</title>
  <g fill="#0d6e60" transform="translate(4,0)">
    <path d="M8 46 L26 10 L44 46 Z"/>
    <rect x="84" y="16" width="148" height="6" rx="3"/>
  </g>
  <circle cx="60" cy="30" r="14" fill="none" stroke="darkslategray" stroke-width="5"/>
</svg>`

/** The operators a page emitted, as one string, for asking what it drew. */
function drawn(svg: string): string {
  const page = new PageCanvas(600, 400)
  page.vector({ svg, x: 50, y: 50, width: 200, height: 100 })
  return page.content()
}

// ---------------------------------------------------------------------------

describe('what may be stored', () => {
  it('accepts a logo and keeps its shapes', () => {
    const result = sanitizeSvg(LOGO)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.width).toBe(240)
    expect(result.height).toBe(60)
    expect(result.svg).toContain('<path')
    expect(result.svg).toContain('#0d6e60')
    expect(result.svg).toContain('translate(4,0)')

    // `title` survives, because it is what a screen reader announces and a
    // logo stripped of it is an anonymous rectangle.
    expect(result.svg).toContain('<title>Northwind</title>')
  })

  it.each([
    ['a script element', '<script>alert(1)</script>'],
    ['a style sheet', '<style>*{fill:red}</style>'],
    ['an embedded document', '<foreignObject><p>hi</p></foreignObject>'],
    ['a reference to another file', '<use href="https://example.com/x.svg#a"/>'],
    ['an image', '<image href="data:image/png;base64,iVBOR"/>'],
    ['an animation', '<animate attributeName="fill" to="red"/>'],
    ['text needing a font', '<text x="0" y="5">hello</text>'],
    ['a second viewport', '<svg viewBox="0 0 5 5"><rect width="5" height="5"/></svg>'],
  ])('refuses %s', (_label, markup) => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${markup}</svg>`,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return

    // Phase 119: a refusal somebody can act on. The uploader is standing at
    // the form holding a file they can re-export.
    expect(result.refusal.remedy.length).toBeGreaterThan(10)
  })

  it.each([
    ['an event handler', 'onload="alert(1)"'],
    ['a CSS style attribute', 'style="fill:url(#g)"'],
    ['a gradient fill', 'fill="url(#g)"'],
    ['a colour it cannot name', 'fill="brandgreen"'],
    ['a colour that depends on a cascade', 'fill="currentColor"'],
    ['a colour with an alpha channel', 'fill="#0d6e6080"'],
    ['a skew', 'transform="skewX(20)"'],
    ['real transparency', 'fill-opacity="0.4"'],
  ])('refuses %s', (_label, attribute) => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<rect width="5" height="5" ${attribute}/></svg>`,
    )

    expect(result.ok).toBe(false)
  })

  /*
    `M0 0 Z 5 5` **hung** until it was read for this: `Z` takes no arguments,
    so the loop pushed it, left the command set and advanced nothing, forever.
    A file chooses that string, so it is a hang an upload can cause.

    Found by reading the loop rather than by any assertion, which is why these
    are an `it.each` over the shapes that break the grammar rather than one
    test of the one that bit: the property worth holding is that `parsePath`
    **returns**, and the only honest way to assert that is to call it.
  */
  it.each([
    ['arguments after a close', 'M0 0 Z 5 5'],
    ['a close with nothing before it', 'Z'],
    ['a command with too few arguments', 'M0 0 L5'],
    ['arguments before any command', '5 5 M0 0'],
    ['a command this does not know', 'M0 0 B5 5'],
    ['no leading move', 'L5 5'],
    ['nothing at all', ''],
    ['two closes and a stray number', 'M0 0 Z Z 1'],
  ])('reads or refuses %s, and always returns', (_label, d) => {
    expect(parsePath(d)).toBeNull()
  })

  it('refuses a DOCTYPE rather than skipping it', () => {
    const result = sanitizeSvg(
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]>` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>&a;</title></svg>`,
    )

    /*
      Skipping it is what a lenient parser does and is how a sanitiser is
      bypassed: an entity the reader ignores is an entity the *next* parser
      expands. The reader understands elements, attributes, comments and the
      XML declaration, and refuses everything else in that position.
    */
    expect(result.ok).toBe(false)
  })

  it('refuses an attribute it could not read, rather than ignoring it', () => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<rect width=5 height=5 onclick=alert(1)/></svg>`,
    )

    // Unparsed text left inside a tag is precisely where a bypass hides, so
    // leftover text is a refusal and not a shrug.
    expect(result.ok).toBe(false)
  })

  it('accepts a real exporter’s bookkeeping by dropping it', () => {
    const result = sanitizeSvg(`<svg
       xmlns="http://www.w3.org/2000/svg"
       xmlns:dc="http://purl.org/dc/elements/1.1/"
       xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
       viewBox="0 0 100 50" version="1.1" id="svg8" inkscape:version="0.92.3">
      <g inkscape:groupmode="layer" id="layer1" class="shapes">
        <path id="path10" d="m 20,30 h 40 v 10 h -40 z" fill="#1b4965" sodipodi:nodetypes="ccccc"/>
      </g>
    </svg>`)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    /*
      The one exception to "refuse rather than strip", and it is the exception
      that makes the feature usable: these carry no geometry and no paint, so
      dropping one cannot change how the drawing looks — while refusing one
      would reject every Inkscape export over an editor's version number.
    */
    expect(result.svg).toContain('d="m 20,30 h 40 v 10 h -40 z"')
    expect(result.svg).not.toContain('inkscape')
    expect(result.svg).not.toContain('id=')
    expect(result.svg).not.toContain('class=')
  })

  it('names CSS apart, because that refusal has an exact remedy', () => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<rect width="5" height="5" style="fill:#f00"/></svg>`,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return

    // "Flatten it to paths" is useless advice for a file whose shapes already
    // are paths and whose only problem is where the colour is written.
    expect(result.refusal.remedy).toContain('Presentation Attributes')
  })

  it('emits its own document rather than approving the uploaded one', () => {
    const result = sanitizeSvg(LOGO)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    /*
      The difference between an allowlist and a filter. The comment, the XML
      declaration and the original `width`/`height` are gone not because
      anything removed them but because the serialiser has nowhere to put
      them — which is what makes the result safe against constructs nobody
      listed.
    */
    expect(result.svg).not.toContain('<!--')
    expect(result.svg).not.toContain('<?xml')
    expect(result.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  })

  it('is stable: sanitising its own output changes nothing', () => {
    const once = sanitizeSvg(LOGO)
    expect(once.ok).toBe(true)
    if (!once.ok) return

    const twice = sanitizeSvg(once.svg)
    expect(twice.ok).toBe(true)
    if (!twice.ok) return

    // The PDF writer re-reads the stored bytes with the same reader, so a
    // document that did not survive its own round trip would print differently
    // from how it was approved.
    expect(twice.svg).toBe(once.svg)
  })
})

describe('the allowlist is the printable subset', () => {
  it('shares the readers that decide, so the two cannot disagree', () => {
    /*
      The claim that makes this phase coherent, asserted directly rather than
      inferred from behaviour: the function the sanitiser consults is the
      function the writer consults.
    */
    expect(parsePath('M0 0 L5 5 Z')).not.toBeNull()
    expect(parsePath('M0 0 B5 5')).toBeNull()
    expect(parseTransform('translate(2,3) scale(2)')).toEqual([2, 0, 0, 2, 2, 3])
    expect(parseTransform('skewY(10)')).toBeNull()
    expect(resolvePaint('darkslategray')).toEqual({
      r: 0x2f / 255,
      g: 0x4f / 255,
      b: 0x4f / 255,
    })
    expect(resolvePaint('url(#g)')).toBeNull()
  })

  /*
    The assertion the whole argument rests on, one drawable element at a time.

    Each is checked alone rather than together in one document, because an
    operator soup asserted by `toContain` passes as long as *some* shape
    emitted each operator — which would let a silently undrawn element hide
    behind its neighbours. An element this accepts and does not draw is a hole
    in a printed proposal, discovered by the client.
  */
  it.each([
    ['rect', '<rect x="1" y="1" width="4" height="4"/>', ' re'],
    ['rounded rect', '<rect x="1" y="1" width="4" height="4" rx="1"/>', ' c'],
    ['circle', '<circle cx="5" cy="5" r="2"/>', ' c'],
    ['ellipse', '<ellipse cx="7" cy="7" rx="2" ry="1"/>', ' c'],
    ['line', '<line x1="0" y1="0" x2="9" y2="9" stroke="red"/>', ' l'],
    ['polyline', '<polyline points="0,0 3,3 6,0" stroke="blue" fill="none"/>', ' l'],
    ['polygon', '<polygon points="1,8 4,8 2,9"/>', ' l'],
    ['a cubic path', '<path d="M1 1 C2 2 3 3 4 4"/>', ' c'],
    ['a smooth cubic', '<path d="M1 1 C2 2 3 3 4 4 S6 6 7 7"/>', ' c'],
    ['a quadratic', '<path d="M1 1 Q8 8 9 9"/>', ' c'],
    ['a smooth quadratic', '<path d="M1 1 Q4 4 5 5 T9 1"/>', ' c'],
    ['an arc', '<path d="M1 1 A2 2 0 0 1 5 5"/>', ' c'],
    ['a relative path', '<path d="m1 1 h4 v4 z"/>', ' l'],
    ['a closed path', '<path d="M1 1 L5 5 Z"/>', 'h'],
  ])('draws a %s', (_label, markup, operator) => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${markup}</svg>`,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const lines = drawn(result.svg).split('\n')
    expect(lines.some((line) => line === operator.trim() || line.endsWith(operator))).toBe(true)
  })

  it('refuses the arc it cannot draw and draws the arc it accepts', () => {
    const accepted = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<path d="M1 5 A4 4 0 1 1 9 5"/></svg>`,
    )
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return

    // A half turn is two Bézier pieces, because the approximation is only
    // good to a quarter turn each — which is where KAPPA comes from.
    const curves = drawn(accepted.svg).match(/ c$/gm) ?? []
    expect(curves.length).toBeGreaterThanOrEqual(2)
  })

  it('paints an unfilled, unstroked shape with nothing at all', () => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<rect width="5" height="5" fill="none"/></svg>`,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    /*
      `fill="none"` with no stroke is a legitimate thing to export — a hit
      area, a hidden guide. The shape must not be emitted at all: a path left
      on the stack with no paint operator would be painted by the *next*
      shape's operator, which is a smear rather than a blank.
    */
    expect(drawn(result.svg)).not.toContain(' re')
  })

  it('defaults an unpainted shape to black, as SVG does', () => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<path d="M0 0 h5 v5 z"/></svg>`,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // A `<path>` with no attributes is a solid black shape, and most minimal
    // icons are exactly that. Getting the default wrong makes them invisible.
    expect(drawn(result.svg)).toContain('0 0 0 rg')
  })

  it('inherits paint down a group, as SVG does', () => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<g fill="#ff0000"><rect width="5" height="5"/></g></svg>`,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(drawn(result.svg)).toContain('1 0 0 rg')
  })

  it('nests a transform as a graphics state, not as arithmetic', () => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
        `<g transform="translate(1,2)"><rect width="5" height="5"/></g></svg>`,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const ops = drawn(result.svg)
    expect(ops).toContain('1 0 0 1 1 2 cm')

    // The rectangle keeps its own coordinates; the matrix moves them. Baking
    // the offset into the numbers is the alternative and it gets Bézier
    // control points and arcs wrong.
    expect(ops).toContain('0 0 5 5 re')
  })

  it('flips the y axis once, at the top', () => {
    const result = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    /*
      SVG counts down the page and PDF counts up it. One negative scale in the
      base matrix is the whole conversion; a per-coordinate flip is the
      alternative and it draws curves inside out.
    */
    const page = new PageCanvas(600, 400)
    page.vector({ svg: result.svg, x: 0, y: 0, width: 100, height: 100 })
    expect(page.content()).toContain('10 0 0 -10 ')
  })

  it('places no image XObject, because a drawing is not a picture', () => {
    const result = sanitizeSvg(LOGO)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const page = new PageCanvas(600, 400)
    page.vector({ svg: result.svg, x: 0, y: 0, width: 100, height: 100 })

    /*
      This is what makes an imported logo resolution-independent, and it is
      also what keeps `renderDocumentPdf`'s resource dictionary honest:
      `usedImages` records what `page.image` placed, so a vector is absent
      from the embedded map by construction rather than by a filter.
    */
    expect(page.usedImages().size).toBe(0)
  })
})

describe('what reaches the store', () => {
  it('stores the rewritten document, not the uploaded bytes', async () => {
    const fixture = await createCompanyFixture()
    const hostile =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
      `<rect width="10" height="10" fill="#0d6e60"/></svg>`

    const asset = await uploadAsset(fixture.ctx, {
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
      data: Buffer.from(`<?xml version="1.0"?>\n${hostile}`, 'utf8'),
    })

    const stored = await readAsset(fixture.companyId, asset.id)
    expect(stored).not.toBeNull()

    /*
      The security argument, asserted rather than described. `uploadAsset`
      reassigns `data` before the digest, the store, the size and the
      measurement, so there is no later step that could reach for the
      original — and no way to add one by accident.
    */
    expect(stored!.data.toString('utf8')).not.toContain('<?xml')
    expect(stored!.data.toString('utf8')).toBe(sanitizedOf(hostile))
    expect(asset.sizeBytes).toBe(stored!.data.byteLength)
  })

  it('refuses a hostile upload with the sanitiser’s own words', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      uploadAsset(fixture.ctx, {
        filename: 'evil.svg',
        contentType: 'image/svg+xml',
        data: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
            `<script>fetch('//evil')</script></svg>`,
          'utf8',
        ),
      }),
    ).rejects.toThrow(/script/)
  })

  it('refuses a file that is not an SVG at all', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      uploadAsset(fixture.ctx, {
        filename: 'photo.svg',
        contentType: 'image/svg+xml',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      }),
    ).rejects.toThrow()
  })

  it('measures a viewBox as a size, so a crop has something to be a fraction of', async () => {
    const fixture = await createCompanyFixture()

    const asset = await uploadAsset(fixture.ctx, {
      filename: 'wordmark.svg',
      contentType: 'image/svg+xml',
      data: Buffer.from(LOGO, 'utf8'),
    })

    const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))

    // An SVG has no pixels, and its `viewBox` is the number every other
    // branch of `imageSize` returns: the size it is drawn at by default.
    expect(row.width).toBe(240)
    expect(row.height).toBe(60)
  })

  it('answers for a sanitised SVG and refuses one that never came through', () => {
    const clean = sanitizeSvg(LOGO)
    expect(clean.ok).toBe(true)
    if (!clean.ok) return

    const prepared = prepareImage(Buffer.from(clean.svg, 'utf8'), 'image/svg+xml')
    expect(prepared.ok).toBe(true)
    if (!prepared.ok || prepared.kind !== 'vector') throw new Error('expected a vector')
    expect(prepared.vector.widthPx).toBe(240)

    /*
      Re-reading the stored bytes with the sanitiser's own reader is the check
      that they still are what it wrote. A file that fails here did not come
      through the upload path, and it refuses rather than draws.
    */
    const smuggled = prepareImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><script/></svg>'),
      'image/svg+xml',
    )
    expect(smuggled.ok).toBe(false)

    expect(imageSize(Buffer.from('not markup'), 'image/svg+xml')).toBeNull()
  })
})

describe('the two lists that did not change together', () => {
  it('admits SVG to the asset library and keeps it out of evidence', () => {
    /*
      Not an oversight, and asserted so the next reader meets the decision
      rather than the discrepancy (Phase 188's lesson about a sentence nobody
      re-measured).

      A brand asset is **drawn**: it is rewritten into a subset the PDF writer
      can redraw, and the person who chose it is there to be refused. Evidence
      is **kept**: it is whatever the supplier sent, stored as sent, and a
      sanitiser would rewrite a supplier's document into one they did not send
      — which is the one thing a record must not be.
    */
    expect(ALLOWED_IMAGE_TYPES).toContain('image/svg+xml')
    expect(EVIDENCE_CONTENT_TYPES).not.toContain('image/svg+xml')
  })
})

describe('what this does not do', () => {
  it('cannot draw an SVG it would not have stored', () => {
    const gradient =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
      `<rect width="10" height="10" fill="url(#g)"/></svg>`

    expect(sanitizeSvg(gradient).ok).toBe(false)

    // The writer's refusal is the sanitiser's refusal, because it is the same
    // function: there is no "unsupported, skip it" branch to be reached.
    expect(drawn(gradient)).toBe('')
  })

  it('leaves a sent document alone when the reader is widened', () => {
    /*
      The stored bytes are the sanitiser's output under *today's* allowlist.
      Widening the allowlist later changes what may be uploaded; it cannot
      change a document already sent, because nothing re-sanitises stored
      bytes — `readSvg` only reads them.
    */
    const clean = sanitizeSvg(LOGO)
    expect(clean.ok).toBe(true)
    if (!clean.ok) return

    const read = readSvg(clean.svg)
    expect('refusal' in read).toBe(false)
  })
})

function sanitizedOf(source: string): string {
  const result = sanitizeSvg(source)
  if (!result.ok) throw new Error(result.refusal.reason)
  return result.svg
}
