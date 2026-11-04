import { describe, expect, it } from 'vitest'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { EMBEDDABLE_CONTENT_TYPES, prepareImage } from '@/modules/pdf/images'
import { imageResourceName, renderDocumentPdf } from '@/modules/pdf/layout'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import type { Block } from '@/modules/design/blocks'
import type { ImageResult } from '@/modules/pdf/images'
import type { RenderedTeamMember } from '@/modules/studio/team'

/**
 * The pictures that never printed (Phase 185, spec §7 and §15).
 *
 * ADR 0184 nominated crop and mask on images. Measuring first found something
 * underneath it: **the PDF contained no images at all.** An `image` block drew
 * a grey frame labelled *"Image — see the online version"*, the `cover` block's
 * `showLogo` was ignored outright, and Phase 183's headshots were stated as not
 * drawn. So the company logo, the product photograph and the capability
 * statement's faces all reached the web page and reached paper as empty boxes —
 * and paper is what a client downloads, prints, signs and files.
 *
 * Cropping a picture the PDF cannot draw is a crop the client never sees, so
 * this is the phase underneath the nominated one.
 *
 * ## What these tests are mostly about
 *
 * **That nothing is decoded.** This project has nine dependencies and no image
 * codec, and needs none: a JPEG embeds byte for byte under `/DCTDecode`, and a
 * PNG's `IDAT` embeds byte for byte under `/FlateDecode` with `/Predictor 15`,
 * which *is* the PNG filter set — the PDF specification adopted it. The
 * assertions below are therefore mostly identity assertions: the bytes in the
 * file are the bytes that were uploaded.
 *
 * **That the one real decode is right.** PDF keeps transparency in a separate
 * `/SMask`, so a PNG with alpha has to be inflated, unfiltered and split. That
 * is the only path where a pixel is looked at, and it is checked by reading the
 * samples back out.
 *
 * **That a refusal is a sentence.** WebP and GIF cannot go in a PDF and the
 * asset library accepts both. The frame now names the file and the remedy
 * instead of telling somebody holding a printed page to look online.
 */

// ---------------------------------------------------------------------------
// Fixtures, built here so the bytes are known
// ---------------------------------------------------------------------------

/**
 * A PNG, encoded by hand.
 *
 * Deliberately not a fixture file. The central claim of this phase is that the
 * `IDAT` stream reaches the PDF untouched, and a test can only assert that
 * against bytes it chose — a file read from disk would let the claim be
 * "something came out" rather than "this exact stream came out".
 */
function png(options: {
  width: number
  height: number
  colorType: 0 | 2 | 3 | 4 | 6
  bitDepth?: number
  /** Unfiltered sample rows; the encoder adds the per-row filter byte. */
  rows: number[][]
  palette?: number[]
  interlace?: boolean
  transparentPalette?: boolean
}): Buffer {
  const bitDepth = options.bitDepth ?? 8

  const chunk = (kind: string, body: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const tagged = Buffer.concat([Buffer.from(kind, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tagged) >>> 0)
    return Buffer.concat([length, tagged, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(options.width, 0)
  ihdr.writeUInt32BE(options.height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = options.colorType
  ihdr[12] = options.interlace ? 1 : 0

  // Filter type 0 (None) on every row, so the samples are literal.
  const raw = Buffer.concat(options.rows.map((row) => Buffer.from([0, ...row])))

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ]

  if (options.palette) chunks.push(chunk('PLTE', Buffer.from(options.palette)))
  if (options.transparentPalette) chunks.push(chunk('tRNS', Buffer.from([0])))

  chunks.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)))

  return Buffer.concat(chunks)
}

/** A baseline JPEG header with an SOF0, which is all the reader looks at. */
function jpeg(options: { width: number; height: number; components: number; marker?: number }) {
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffd8, 0) // SOI
  sof.writeUInt16BE(0xffe0, 2) // APP0
  sof.writeUInt16BE(5, 4) // its length
  sof[6] = 0x4a
  sof.writeUInt16BE(0xff00 | (options.marker ?? 0xc0), 9)
  sof.writeUInt16BE(11, 11)
  sof[13] = 8
  sof.writeUInt16BE(options.height, 14)
  sof.writeUInt16BE(options.width, 16)
  sof[18] = options.components

  return Buffer.concat([sof, Buffer.from([0xff, 0xd9])])
}

const RED_BLUE_ROWS = [
  [220, 40, 40, 40, 80, 220],
  [220, 40, 40, 40, 80, 220],
]

// ---------------------------------------------------------------------------

describe('a JPEG goes in untouched', () => {
  it('reads its size and colour space from the frame header', () => {
    const result = prepareImage(jpeg({ width: 640, height: 480, components: 3 }), 'image/jpeg')

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.image.widthPx).toBe(640)
    expect(result.image.heightPx).toBe(480)
    expect(result.image.colorSpace).toBe('/DeviceRGB')
    expect(result.image.filter).toBe('DCTDecode')
  })

  it('embeds the file byte for byte', () => {
    const file = jpeg({ width: 8, height: 4, components: 1 })
    const result = prepareImage(file, 'image/jpeg')

    expect(result.ok).toBe(true)
    if (!result.ok) return

    /*
      The whole argument for having no image library. A PDF viewer contains a
      JPEG decoder, so ours does not have to: the stream is the file, which
      means nothing is re-encoded and a photograph loses nothing between the
      upload and the page.
    */
    expect(result.image.data.equals(file)).toBe(true)
    expect(result.image.colorSpace).toBe('/DeviceGray')
    expect(result.image.decodeParms).toBeNull()
    expect(result.image.smask).toBeNull()
  })

  it('refuses a progressive one, rather than rendering in some readers', () => {
    // `/DCTDecode` is specified to accept progressive and real viewers disagree
    // about it. A proposal that renders in one PDF reader and not another is
    // worse than one that says so before it is sent.
    const result = prepareImage(jpeg({ width: 8, height: 4, components: 3, marker: 0xc2 }), 'image/jpeg')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toMatch(/progressive/)
    expect(result.refusal.remedy).toMatch(/baseline/)
  })

  it('refuses CMYK rather than printing a negative', () => {
    const result = prepareImage(jpeg({ width: 8, height: 4, components: 4 }), 'image/jpeg')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toMatch(/4 colour channels/)
  })
})

describe('a PNG without transparency goes in untouched too', () => {
  it('passes the compressed rows through with the PNG predictor', () => {
    const file = png({ width: 2, height: 2, colorType: 2, rows: RED_BLUE_ROWS })
    const result = prepareImage(file, 'image/png')

    expect(result.ok).toBe(true)
    if (!result.ok) return

    /*
      `/Predictor 15` means "the PNG filter set, chosen per row", which is what
      every PNG row's leading byte already says — the PDF specification adopted
      PNG's filters verbatim for exactly this. So the `IDAT` is the stream, and
      this asserts the identity rather than the shape.
    */
    expect(result.image.filter).toBe('FlateDecode')
    expect(result.image.decodeParms).toContain('/Predictor 15')
    expect(result.image.decodeParms).toContain('/Colors 3')
    expect(result.image.decodeParms).toContain('/Columns 2')

    const idat = idatOf(file)
    expect(result.image.data.equals(idat)).toBe(true)
    expect(result.image.smask).toBeNull()
  })

  it('carries a palette into the colour space', () => {
    const file = png({
      width: 2,
      height: 1,
      colorType: 3,
      rows: [[0, 1]],
      palette: [220, 40, 40, 40, 80, 220],
    })

    const result = prepareImage(file, 'image/png')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // `hival` is the last index, not the count — one of the two numbers in a
    // PDF image dictionary that is off by one on a first attempt.
    expect(result.image.colorSpace).toBe('[/Indexed /DeviceRGB 1 <dc28282850dc>]')
    expect(result.image.decodeParms).toContain('/Colors 1')
  })

  it('reads greyscale as greyscale', () => {
    const result = prepareImage(
      png({ width: 2, height: 1, colorType: 0, rows: [[10, 250]] }),
      'image/png',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.image.colorSpace).toBe('/DeviceGray')
  })

  it('refuses an interlaced one', () => {
    const result = prepareImage(
      png({ width: 2, height: 2, colorType: 2, rows: RED_BLUE_ROWS, interlace: true }),
      'image/png',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    // Adam7 reorders the pixels into seven passes, so the predictor no longer
    // describes the rows and the stream cannot be passed through.
    expect(result.refusal.reason).toMatch(/interlaced/)
  })

  it('refuses a transparent palette entry rather than printing a black box', () => {
    const file = png({
      width: 2,
      height: 1,
      colorType: 3,
      rows: [[0, 1]],
      palette: [220, 40, 40, 40, 80, 220],
      transparentPalette: true,
    })

    const result = prepareImage(file, 'image/png')
    expect(result.ok).toBe(false)
    if (result.ok) return

    // PDF expresses this with `/Mask` on the indices, a different mechanism
    // from `/SMask`. Half-building it gives a logo with a black background,
    // which is the failure nobody notices until a client does.
    expect(result.refusal.reason).toMatch(/transparent palette/)
  })
})

describe('transparency is the one thing that is really decoded', () => {
  it('splits the alpha into its own greyscale image', () => {
    //                     R    G   B    A      R   G    B    A
    const rows = [[220, 40, 40, 128, 40, 80, 220, 255]]
    const result = prepareImage(png({ width: 2, height: 1, colorType: 6, rows }), 'image/png')

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.image.colorSpace).toBe('/DeviceRGB')
    expect(result.image.smask).not.toBeNull()

    /*
      Read back out, because this is the only path where a pixel is looked at
      and the arithmetic can be wrong without anything throwing. A transposed
      split would give a picture tinted by its own alpha, which renders and is
      wrong.
    */
    expect([...inflateSync(result.image.data)]).toEqual([220, 40, 40, 40, 80, 220])
    expect([...inflateSync(result.image.smask!.data)]).toEqual([128, 255])
  })

  it('reverses every one of the five row filters', () => {
    /*
      The filters are the part a first attempt gets wrong, and they are only
      exercised on this path — the pass-through paths never unfilter at all. So
      each one is applied by hand here and the original samples asserted back.

      Four rows of one RGBA pixel, filtered None, Sub, Up, Average, Paeth. The
      arithmetic is bytewise modulo 256, which is what the PNG specification
      says and is the detail that breaks on wide samples.
    */
    const pixels = [
      [10, 20, 30, 255],
      [40, 60, 80, 255],
      [12, 14, 16, 255],
      [200, 210, 220, 255],
      [9, 9, 9, 255],
    ]

    const filtered: number[][] = []
    for (const [index, row] of pixels.entries()) {
      const previous = index > 0 ? pixels[index - 1] : [0, 0, 0, 0]
      const kind = index // 0..4, one of each filter
      const encoded = row.map((value, at) => {
        const left = 0 // one pixel per row, so there is never a left neighbour
        const up = previous[at]
        const upLeft = 0
        const predictor =
          kind === 0
            ? 0
            : kind === 1
              ? left
              : kind === 2
                ? up
                : kind === 3
                  ? (left + up) >> 1
                  : paethFor(left, up, upLeft)
        return (value - predictor) & 0xff
      })
      filtered.push([kind, ...encoded])
    }

    const file = pngPrefiltered({ width: 1, height: 5, colorType: 6, filteredRows: filtered })
    const result = prepareImage(file, 'image/png')

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect([...inflateSync(result.image.data)]).toEqual(pixels.flatMap((p) => p.slice(0, 3)))
    expect([...inflateSync(result.image.smask!.data)]).toEqual(pixels.map((p) => p[3]))
  })

  it('refuses transparency below eight bits a channel', () => {
    const result = prepareImage(
      png({ width: 2, height: 1, colorType: 4, bitDepth: 4, rows: [[0, 0]] }),
      'image/png',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toMatch(/4 bits/)
  })
})

describe('what it will not take', () => {
  it('names WebP and GIF, with the conversion', () => {
    for (const type of ['image/webp', 'image/gif']) {
      const result = prepareImage(Buffer.from('not really an image'), type)

      expect(result.ok).toBe(false)
      if (result.ok) continue

      // The asset library accepts both, so this is reachable from the product
      // rather than from a malformed upload. Phase 119: the remedy is the half
      // that matters.
      expect(result.refusal.reason).toContain(type)
      expect(result.refusal.remedy).toMatch(/Convert it to PNG or JPEG/)
    }
  })

  it('declares what it can take, so the two lists cannot drift', () => {
    // Everything `ALLOWED_IMAGE_TYPES` accepts either embeds or refuses by
    // name; nothing falls through to a generic answer.
    expect([...EMBEDDABLE_CONTENT_TYPES]).toEqual(['image/png', 'image/jpeg'])
  })

  it('says a file is unreadable rather than throwing', () => {
    for (const [bytes, type] of [
      [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
      [Buffer.from('nonsense'), 'image/png'],
    ] as const) {
      const result = prepareImage(bytes, type)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.refusal.remedy.length).toBeGreaterThan(10)
    }
  })
})

// ---------------------------------------------------------------------------

describe('what reaches the page', () => {
  const JPEG_ID = 'aaaaaaaa-0000-0000-0000-00000000000a'
  const WEBP_ID = 'cccccccc-0000-0000-0000-00000000000c'

  function render(blocks: Block[], extra: Partial<Parameters<typeof renderDocumentPdf>[0]> = {}) {
    const file = jpeg({ width: 640, height: 480, components: 3 })

    const images = new Map<string, ImageResult>([
      [JPEG_ID, prepareImage(file, 'image/jpeg')],
      [WEBP_ID, prepareImage(Buffer.from('webp'), 'image/webp')],
    ])

    return {
      file,
      pdf: renderDocumentPdf({
        blocks,
        brand: DEFAULT_BRAND_KIT,
        merge: {},
        pageSize: 'letter',
        orientation: 'portrait',
        showPageNumbers: false,
        images,
        title: 'Proof',
        author: 'Bridgeworks Ltd',
        createdAt: new Date('2026-11-04T00:00:00Z'),
        ...extra,
      }).toString('latin1'),
    }
  }

  const imageBlock = (assetId: string | null): Block =>
    ({
      id: 'i',
      type: 'image',
      assetId,
      caption: '',
      widthPercent: 100,
      align: 'left',
    }) as Block

  it('puts the picture in the file and invokes it', () => {
    const { file, pdf } = render([imageBlock(JPEG_ID)])

    expect(pdf).toContain('/Subtype /Image')
    expect(pdf).toContain('/Filter /DCTDecode')
    expect(pdf).toContain('/Width 640')
    expect(pdf).toContain(`/${imageResourceName(JPEG_ID)} Do`)
    expect(pdf).toContain('/XObject <<')

    // And the bytes are the file's. The end-to-end form of the claim each
    // `prepareImage` test makes about its own half.
    expect(pdf).toContain(file.toString('latin1'))
  })

  it('does not carry a picture nothing places', () => {
    /*
      The map holds the JPEG and the document places only the WebP, which
      refuses. So nothing is placed, and the file must hold no image at all.

      This is the assertion that caught the implementation: the first version
      embedded every *prepared* image rather than every *placed* one, and the
      comment beside it claimed the opposite. An unreferenced XObject is weight
      in the file and a reader wondering why it is there.
    */
    const { pdf } = render([imageBlock(WEBP_ID)])

    expect(pdf).not.toContain(imageResourceName(JPEG_ID))
    expect(pdf).not.toContain('/XObject')
  })

  it('says what is wrong with a picture it cannot print', () => {
    const { pdf } = render([imageBlock(WEBP_ID)])

    expect(pdf).not.toContain('/Subtype /Image')
    expect(pdf).toContain('Cannot print this image')
    expect(pdf).toContain('image/webp cannot be placed in a PDF')
    expect(pdf).toContain('Convert it to PNG or JPEG')
    // The sentence it replaced, which told a client holding paper to go and
    // look at something else.
    expect(pdf).not.toContain('see the online version')
  })

  it('tells the three empty cases apart', () => {
    const missing = render([imageBlock('99999999-0000-0000-0000-000000000099')]).pdf
    const unchosen = render([imageBlock(null)]).pdf

    expect(missing).toContain('no longer in the asset library')
    expect(unchosen).toContain('No image chosen')
    expect(unchosen).not.toContain('no longer in the asset library')
  })

  it('still cannot print a video, and now says where to watch it', () => {
    const video = { id: 'v', type: 'video', url: 'https://x.test/v', caption: '' } as Block
    const pdf = render([video]).pdf

    // Not the same gap as an image's. There is no frame to print, so the box
    // carries a remedy rather than an apology.
    expect(pdf).toContain('open this proposal online')
  })
})

describe('the two blocks whose pictures were never even reached', () => {
  const LOGO = 'dddddddd-0000-0000-0000-00000000000d'
  const FACE = 'eeeeeeee-0000-0000-0000-00000000000e'

  function render(blocks: Block[], extra: Record<string, unknown> = {}) {
    const images = new Map<string, ImageResult>([
      [LOGO, prepareImage(jpeg({ width: 300, height: 100, components: 3 }), 'image/jpeg')],
      [FACE, prepareImage(jpeg({ width: 400, height: 600, components: 3 }), 'image/jpeg')],
    ])

    return renderDocumentPdf({
      blocks,
      brand: DEFAULT_BRAND_KIT,
      merge: {},
      pageSize: 'letter',
      orientation: 'portrait',
      showPageNumbers: false,
      images,
      logoAssetId: LOGO,
      title: 'Proof',
      author: 'Bridgeworks Ltd',
      createdAt: new Date('2026-11-04T00:00:00Z'),
      ...extra,
    }).toString('latin1')
  }

  const cover = (patch: Record<string, unknown> = {}): Block =>
    ({
      id: 'c',
      type: 'cover',
      title: 'Capability statement',
      subtitle: '',
      preparedFor: '',
      showLogo: true,
      useBrandBackground: false,
      ...patch,
    }) as Block

  it('draws the cover logo, which this block has never done', () => {
    // `showLogo` has been a toggle in the editor and honoured on the web page
    // since Phase 5, and ignored here. The first page a client sees.
    expect(render([cover()])).toContain(`/${imageResourceName(LOGO)} Do`)
  })

  it('leaves it off when the author turned it off', () => {
    expect(render([cover({ showLogo: false })])).not.toContain(
      `/${imageResourceName(LOGO)} Do`,
    )
  })

  it('leaves it off the brand-coloured band rather than drawing it invisible', () => {
    /*
      A logo is usually one colour with a transparent surround, so a dark mark
      on a dark band is an invisible logo. Skipped rather than drawn wrong —
      and the band is already the company's colour, which is what the toggle
      was reaching for.
    */
    expect(render([cover({ useBrandBackground: true })])).not.toContain(
      `/${imageResourceName(LOGO)} Do`,
    )
  })

  const team: RenderedTeamMember[] = [
    {
      id: 'm1',
      name: 'Dana Whitlock',
      title: 'Principal',
      qualifications: 'PE, LEED AP',
      bio: 'Twenty years on civic work.',
      headshotAssetId: FACE,
      isActive: true,
    },
  ]

  const teamBlock = (patch: Record<string, unknown> = {}): Block =>
    ({
      id: 't',
      type: 'team',
      title: 'Who you will be working with',
      memberIds: [],
      showPhotos: true,
      showQualifications: true,
      layout: 'list',
      ...patch,
    }) as Block

  it('draws a headshot, which ADR 0183 said it would not', () => {
    /*
      Phase 183 stated the limitation and gave a reason — "embedding an image
      means decoding it" — which was true of this writer then. The rest of that
      sentence, that a photograph at whatever resolution is worse than a name
      set properly, turned out to be about placement: bounded to a square and
      set beside the name, it prints like a capability statement.
    */
    const pdf = render([teamBlock()], { team })

    expect(pdf).toContain(`/${imageResourceName(FACE)} Do`)
    expect(pdf).toContain('Dana Whitlock, PE, LEED AP')
  })

  it('clips it square rather than squashing it', () => {
    const pdf = render([teamBlock()], { team })

    /*
      `re W n` is a clipping path. The 400×600 picture is scaled so its shorter
      side fills the square and the overflow is clipped — which is
      `object-fit: cover` done with PDF operators, and the same answer
      `.doc-team-photo` gives in CSS, so the two renderers agree about the
      shape of a person's face.
    */
    expect(pdf).toMatch(/re\nW\nn/)

    // Scaled on the short side: 56 / 400 × 600 = 84 tall, 56 wide.
    expect(pdf).toContain('56 0 0 84')
  })

  it('honours showPhotos, and falls back to text without one', () => {
    expect(render([teamBlock({ showPhotos: false })], { team })).not.toContain(
      `/${imageResourceName(FACE)} Do`,
    )

    const faceless = render([teamBlock()], {
      team: [{ ...team[0], headshotAssetId: null }],
    })
    expect(faceless).toContain('Dana Whitlock')
    expect(faceless).not.toContain(`/${imageResourceName(FACE)} Do`)
  })
})

// ---------------------------------------------------------------------------

/** A PNG whose rows are already filtered, for the filter test. */
function pngPrefiltered(options: {
  width: number
  height: number
  colorType: number
  filteredRows: number[][]
}): Buffer {
  const chunk = (kind: string, body: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const tagged = Buffer.concat([Buffer.from(kind, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tagged) >>> 0)
    return Buffer.concat([length, tagged, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(options.width, 0)
  ihdr.writeUInt32BE(options.height, 4)
  ihdr[8] = 8
  ihdr[9] = options.colorType

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(options.filteredRows.flat()))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The concatenated IDAT of a PNG, for the pass-through assertion. */
function idatOf(file: Buffer): Buffer {
  const parts: Buffer[] = []
  let at = 8
  while (at + 8 <= file.length) {
    const length = file.readUInt32BE(at)
    const kind = file.subarray(at + 4, at + 8).toString('latin1')
    if (kind === 'IDAT') parts.push(file.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  return Buffer.concat(parts)
}

function paethFor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const dl = Math.abs(estimate - left)
  const du = Math.abs(estimate - up)
  const dul = Math.abs(estimate - upLeft)
  return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft
}
