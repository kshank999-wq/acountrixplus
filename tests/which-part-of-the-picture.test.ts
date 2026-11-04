import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { assets } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { imageSize, prepareImage, type ImageResult } from '@/modules/pdf/images'
import { renderDocumentPdf, imageResourceName } from '@/modules/pdf/layout'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import {
  ROUNDED_MASK_FRACTION,
  WHOLE_IMAGE,
  isWholeImage,
  normalizeCrop,
  parseBlocks,
  validateBlocks,
  type Block,
} from '@/modules/design/blocks'
import {
  assetSizes,
  measureStoredAssets,
  readAsset,
  uploadAsset,
} from '@/modules/studio/assets'
import { BUILT_IN_TEMPLATES } from '@/modules/design/templates'

/**
 * Which part of the picture (Phase 186, spec §7's `crop/mask`).
 *
 * ADR 0184 nominated this and ADR 0185 built the layer underneath it — the PDF
 * had no images at all, so a crop would have been one no client ever saw. With
 * pictures on the page, a crop is finally a thing somebody can be shown.
 *
 * ## What measuring found this time
 *
 * `assets.width` and `assets.height` have existed since **Phase 4**, carrying
 * the comment *"Pixel dimensions when known, so layout can reserve space."* No
 * caller has ever passed them, nothing has ever read them, and every row is
 * NULL. Phase 49's rule twice in one row: a column with no writer and no reader
 * is a field that does not exist.
 *
 * That is not a tidy-up here, it is the blocker. **A crop is not expressible in
 * CSS without the source's aspect ratio** — the cropped box has to take the
 * cropped shape, and the browser can only work that out from the original's
 * proportions. So the nominated feature could not reach a client's page until
 * those two columns held something.
 *
 * ## The three claims
 *
 * **Fractions, not pixels**, so a crop survives the asset being replaced by a
 * larger scan of the same photograph.
 *
 * **One answer about where a box may be.** `normalizeCrop` is shared by the
 * editor, the page and the PDF, so the box an author drags is the box a client
 * sees — which is the one thing a crop control must not get wrong.
 *
 * **Nothing is resampled.** A crop in a PDF is a clipping path and a scale, so
 * a cropped photograph prints at exactly the resolution it was uploaded at.
 */

// ---------------------------------------------------------------------------

/** A JPEG header of a chosen size. The pixels are never read. */
function jpegOf(width: number, height: number): Buffer {
  const head = Buffer.alloc(19)
  head.writeUInt16BE(0xffd8, 0)
  head.writeUInt16BE(0xffe0, 2)
  head.writeUInt16BE(5, 4)
  head.writeUInt16BE(0xffc0, 9)
  head.writeUInt16BE(11, 11)
  head[13] = 8
  head.writeUInt16BE(height, 14)
  head.writeUInt16BE(width, 16)
  head[18] = 3
  return Buffer.concat([head, Buffer.from([0xff, 0xd9])])
}

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6300010000050001',
  'hex',
)

// ---------------------------------------------------------------------------

describe('the crop itself', () => {
  it('defaults to the whole picture, so an older block still shows one', () => {
    /*
      The assertion that matters most for an existing document. Every `image`
      block stored before this phase has no `crop` key at all, and a schema
      without a default would read those back as invalid and drop the picture
      from a proposal a client already has a link to.
    */
    const [block] = parseBlocks([
      { id: 'i', type: 'image', assetId: 'a', caption: '', widthPercent: 100, align: 'left' },
    ]) as Array<Extract<Block, { type: 'image' }>>

    expect(block.crop).toEqual(WHOLE_IMAGE)
    expect(block.maskShape).toBe('none')
    expect(isWholeImage(block.crop)).toBe(true)
  })

  it('pulls a box back onto the picture rather than shrinking it', () => {
    /*
      The behaviour an author's hand depends on. Dragging a box off the right
      edge means "as far right as it goes", not "make it narrower" — and a
      control whose box changes shape under the pointer is a control nobody
      trusts.
    */
    expect(normalizeCrop({ x: 0.8, y: 0.9, width: 0.5, height: 0.4 })).toEqual({
      x: 0.5,
      y: 0.6,
      width: 0.5,
      height: 0.4,
    })
  })

  it('refuses to crop a picture down to nothing', () => {
    const tiny = normalizeCrop({ x: 0, y: 0, width: 0, height: -1 })

    expect(tiny.width).toBe(0.05)
    expect(tiny.height).toBe(0.05)
  })

  it('refuses a crop that runs off the edge on save, and renders it anyway', () => {
    const offEdge = {
      id: 'i',
      type: 'image',
      assetId: 'a',
      caption: '',
      widthPercent: 100,
      align: 'left',
      crop: { x: 0.8, y: 0, width: 0.5, height: 1 },
      maskShape: 'none',
    }

    /*
      Strict on save, lenient on render — the same bargain the table block
      struck in Phase 181, and for the same reason: a document stored by an
      older editor should render rather than disappear from a client-facing
      page.
    */
    const { errors } = validateBlocks([offEdge])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/runs off the edge/)

    const [parsed] = parseBlocks([offEdge]) as Array<Extract<Block, { type: 'image' }>>
    expect(normalizeCrop(parsed.crop).x).toBe(0.5)
  })

  it('survives the asset being replaced by a bigger scan', () => {
    /*
      Why the crop is fractions. The same numbers describe the same part of the
      same photograph at 600 pixels wide and at 3000, which is what happens when
      somebody re-scans a certificate at a higher resolution.
    */
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }

    for (const [width, height] of [
      [600, 400],
      [3000, 2000],
    ]) {
      expect(crop.x * width).toBe(width / 4)
      expect(crop.width * height).toBe(height / 2)
    }
  })
})

describe('the two columns that made it possible', () => {
  it('measures a picture at upload, which nothing has ever done', async () => {
    const fixture = await createCompanyFixture()

    const asset = await uploadAsset(fixture.ctx, {
      filename: 'site.jpg',
      contentType: 'image/jpeg',
      data: jpegOf(1600, 900),
    })

    const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))

    expect(row.width).toBe(1600)
    expect(row.height).toBe(900)
  })

  it('believes the file over the caller', () => {
    // A caller that is wrong about this crops somebody's photograph in the
    // wrong place, so the header wins.
    expect(imageSize(jpegOf(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 })
  })

  it('measures a WebP, which the PDF cannot print', async () => {
    const fixture = await createCompanyFixture()

    /*
      Deliberately asymmetric. A size is a fact about the file and a browser can
      crop a WebP perfectly well; tying the measurement to what a printer can
      embed would have made the page's crop depend on the PDF's limits.
    */
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBPVP8X'),
      Buffer.alloc(4),
      Buffer.alloc(4),
      // 24 bits each, one less than the real size.
      Buffer.from([0x3f, 0x00, 0x00, 0x1d, 0x00, 0x00]),
      Buffer.alloc(8),
    ])

    const asset = await uploadAsset(fixture.ctx, {
      filename: 'hero.webp',
      contentType: 'image/webp',
      data: webp,
    })

    const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))
    expect(row.width).toBe(64)
    expect(row.height).toBe(30)

    // And it still refuses to print, with the conversion to make.
    const found = await readAsset(fixture.companyId, asset.id)
    expect(prepareImage(found!.data, 'image/webp').ok).toBe(false)
  })

  it('leaves an unreadable file unmeasured rather than guessing', async () => {
    const fixture = await createCompanyFixture()

    const asset = await uploadAsset(fixture.ctx, {
      filename: 'broken.png',
      contentType: 'image/png',
      data: Buffer.from('this is not a png'),
    })

    const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))
    expect(row.width).toBeNull()

    // And the crop degrades rather than dividing by a zero it invented.
    expect(await assetSizes(fixture.companyId, [asset.id])).toEqual({})
  })

  it('measures the ones uploaded before it started measuring', async () => {
    const fixture = await createCompanyFixture()

    const asset = await uploadAsset(fixture.ctx, {
      filename: 'old.png',
      contentType: 'image/png',
      data: PNG_1x1,
    })

    // Back to how every row in the table looked before this phase.
    await db.update(assets).set({ width: null, height: null }).where(eq(assets.id, asset.id))

    /*
      An operation somebody runs, not a migration — SQL cannot read a PNG
      header — and not a lazy fill on read, because the read that would do it
      is on the client-facing proposal page and a read that writes is a
      surprise.
    */
    const result = await measureStoredAssets(fixture.ctx)

    expect(result).toEqual({ measured: 1, unreadable: 0 })
    expect(await assetSizes(fixture.companyId, [asset.id])).toEqual({
      [asset.id]: { width: 1, height: 1 },
    })
  })

  it('counts what it could not read, rather than retrying it forever', async () => {
    const fixture = await createCompanyFixture()

    await uploadAsset(fixture.ctx, {
      filename: 'broken.gif',
      contentType: 'image/gif',
      data: Buffer.from('not a gif at all'),
    })

    expect(await measureStoredAssets(fixture.ctx)).toEqual({ measured: 0, unreadable: 1 })
  })

  it('does not hand one company another company\'s sizes', async () => {
    const mine = await createCompanyFixture({ name: 'Mine' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })

    const asset = await uploadAsset(theirs.ctx, {
      filename: 'theirs.jpg',
      contentType: 'image/jpeg',
      data: jpegOf(100, 50),
    })

    expect(await assetSizes(mine.companyId, [asset.id])).toEqual({})
    expect(await assetSizes(theirs.companyId, [asset.id])).toHaveProperty(asset.id)
  })
})

describe('what a crop does to the PDF', () => {
  const ID = 'aaaaaaaa-0000-0000-0000-00000000000a'

  function render(patch: Record<string, unknown>) {
    const images = new Map<string, ImageResult>([
      [ID, prepareImage(jpegOf(1000, 500), 'image/jpeg')],
    ])

    const block = {
      id: 'i',
      type: 'image',
      assetId: ID,
      caption: '',
      widthPercent: 100,
      align: 'left',
      crop: WHOLE_IMAGE,
      maskShape: 'none',
      ...patch,
    } as Block

    return renderDocumentPdf({
      blocks: [block],
      brand: DEFAULT_BRAND_KIT,
      merge: {},
      pageSize: 'letter',
      orientation: 'portrait',
      showPageNumbers: false,
      images,
      title: 'Proof',
      author: 'Bridgeworks Ltd',
      createdAt: new Date('2026-11-04T00:00:00Z'),
    }).toString('latin1')
  }

  it('emits exactly what it used to when nothing is cropped', () => {
    // The common case must not pay for the feature, and must not change: a
    // document that was byte-stable before this phase still is.
    const pdf = render({})

    expect(pdf).not.toContain('W\nn')
    expect(pdf).toContain(`/${imageResourceName(ID)} Do`)
  })

  it('clips rather than resampling', () => {
    const pdf = render({ crop: { x: 0.25, y: 0, width: 0.5, height: 1 } })

    /*
      `re W n` is a clipping path and the `cm` before `Do` is a scale. Nothing
      touches a pixel, so a cropped photograph prints at exactly the resolution
      it was uploaded at — which is why a crop is free here and would not be if
      it were done by re-encoding.
    */
    expect(pdf).toContain('W\nn')

    // The content width is 504pt. Halved horizontally, the picture is drawn at
    // 1008pt wide and shifted a quarter of that left.
    expect(pdf).toContain('1008 0 0 504')
  })

  it('takes the cropped shape, not the original one', () => {
    // A 1000×500 picture cropped to its middle square is a square on the page.
    const pdf = render({ crop: { x: 0.25, y: 0, width: 0.5, height: 1 } })

    /*
      The clip box is 504 wide and 504 tall — a square — because the crop took
      a 500×500 region out of a 1000×500 picture. The uncropped block would be
      504 by 252, so this is the assertion that the *box* follows the crop and
      not the source.

      Width and height only: the `y` is wherever the piece landed on the page,
      and pinning that would make this a test of pagination.
    */
    expect(pdf).toContain('504 504 re')
    expect(render({})).toContain('504 0 0 252')
  })

  it('draws a circle as four Bézier curves, not a rectangle', () => {
    const pdf = render({ maskShape: 'circle' })

    /*
      A mask is an outline and §7 pairs it with a crop in one bullet. Four
      curves, because that is how a PDF draws an ellipse — and an ellipse
      rather than a circle is the right generalisation, since that is what
      `border-radius: 50%` does on the page and the two have to agree.
    */
    expect(pdf.match(/ c\n/g)?.length).toBe(4)
    expect(pdf).toContain(' m\n')
  })

  it('draws a rounded corner at the fraction the page uses', () => {
    const pdf = render({ maskShape: 'rounded' })

    // Four corners, four curves, and the radius is the shared constant — a
    // corner rounder on screen than on paper is two documents.
    expect(pdf.match(/ c\n/g)?.length).toBe(4)
    expect(pdf.match(/ l\n/g)?.length).toBe(4)
    expect(ROUNDED_MASK_FRACTION).toBe(0.08)

    /*
      The box is 504 × 252, so the radius is the shorter side × 0.08 = 20.16,
      and the path starts one radius along the bottom edge from the left
      margin: 54 + 20.16.
    */
    expect(pdf).toContain('74.16 ')
  })

  it('masks without a crop, and crops without a mask', () => {
    // Two operations in one bullet, and they compose rather than being modes.
    expect(render({ maskShape: 'circle' })).toContain('W\nn')
    expect(render({ crop: { x: 0, y: 0.5, width: 1, height: 0.5 } })).toContain('W\nn')

    const both = render({
      maskShape: 'circle',
      crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    })
    expect(both.match(/ c\n/g)?.length).toBe(4)
    expect(both).toContain('1008 0 0 504')
  })
})

describe('the headshot keeps its own crop and gains an outline', () => {
  it('offers three shapes and defaults to the square it already was', () => {
    const [block] = parseBlocks([
      { id: 't', type: 'team', memberIds: [] },
    ]) as Array<Extract<Block, { type: 'team' }>>

    // A headshot is cropped to a square either way — a directory of mixed
    // portrait and landscape faces reads as a mistake — so the choice is the
    // outline, and the default is what Phase 183 shipped.
    expect(block.photoShape).toBe('square')
  })

  it('leaves the template\'s headshots square', () => {
    const template = BUILT_IN_TEMPLATES.find((entry) => entry.key === 'professional-engagement')
    const block = template?.blocks.find((entry) => entry.type === 'team')

    expect(block && 'photoShape' in block ? block.photoShape : null).toBe('square')
  })
})
