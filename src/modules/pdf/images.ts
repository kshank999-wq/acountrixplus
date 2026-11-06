import { deflateSync, inflateSync } from 'node:zlib'
import { readSvg } from '@/modules/design/svg'

/**
 * Turning an uploaded picture into a PDF image XObject (Phase 185, spec §7).
 *
 * ## What was wrong
 *
 * `layout.ts` drew an `image` block as a grey frame labelled *"Image — see the
 * online version"*, and `writer.ts` declared it: *"no images beyond a
 * placeholder frame."* Declared, not hidden — which is why it never read as a
 * defect and why it survived a hundred and sixty phases.
 *
 * It is still a defect. §7 is a design engine and §15 is a brand asset library,
 * and the PDF is the artifact that leaves the building: it is what a client
 * downloads, prints, signs and files. The company logo, the product photograph
 * and (since Phase 183) the headshots on a capability statement all reached the
 * web page perfectly and reached paper as a labelled empty box.
 *
 * ADR 0184 nominated crop and mask. Cropping a picture the PDF cannot draw is a
 * crop the client never sees, so this is the phase underneath that one.
 *
 * ## No image library, and none needed
 *
 * This project has nine dependencies and no image codec. It does not need one,
 * because **PDF speaks both formats natively**:
 *
 * - A JPEG is embedded **byte for byte** with `/Filter /DCTDecode`. A PDF
 *   viewer contains a JPEG decoder; ours does not have to. Nothing is decoded,
 *   re-encoded, or degraded.
 * - A PNG's `IDAT` is a zlib stream of filtered rows, and PDF's
 *   `/FlateDecode` with `/Predictor 15` is *the PNG predictor set*, defined in
 *   the PDF specification for exactly this. So a PNG without alpha is also
 *   embedded byte for byte.
 *
 * Only PNG alpha needs real work, because PDF keeps transparency in a separate
 * `/SMask` image rather than interleaved with the colour. That one is inflated
 * with `node:zlib` — a Node builtin, so still no dependency — unfiltered, split
 * into colour and alpha, and re-deflated.
 *
 * ## What it refuses, and why that is a sentence
 *
 * WebP and GIF are accepted by the asset library and cannot be embedded: WebP
 * is VP8 and GIF is LZW, and neither is a PDF filter. A full decoder for either
 * is a dependency or a thousand lines, and it would be the wrong thousand —
 * converting the upload once is better than decoding it on every render.
 *
 * So they refuse, and the refusal carries **a sentence naming the remedy**
 * (Phase 119). The placeholder in the PDF says which file and what to do about
 * it, instead of the old *"see the online version"* — which told a client
 * holding a printed page to go and look at something else.
 */

/** What `writer.ts` needs to emit one image XObject. */
export type EmbeddableImage = {
  widthPx: number
  heightPx: number
  /** A PDF colour-space expression, already serialised. */
  colorSpace: string
  bitsPerComponent: number
  /** `DCTDecode` for JPEG, `FlateDecode` for PNG. */
  filter: 'DCTDecode' | 'FlateDecode'
  /** The stream bytes, ready to write with no further transformation. */
  data: Buffer
  /** A `/DecodeParms` dictionary body, for a PNG passed through its predictor. */
  decodeParms: string | null
  /** The alpha channel as its own greyscale image, when the source had one. */
  smask: {
    widthPx: number
    heightPx: number
    bitsPerComponent: number
    data: Buffer
  } | null
}

/**
 * Why a picture could not be embedded, in words a person can act on.
 *
 * The `remedy` is the half that matters. "Unsupported format" tells somebody
 * holding a printed proposal nothing; "convert it to PNG or JPEG and upload it
 * again" is a thing they can do before sending it.
 */
export type ImageRefusal = {
  reason: string
  remedy: string
}

/**
 * A sanitised SVG, which is drawn rather than embedded (Phase 190).
 *
 * It carries a pixel size like a raster does, although it has none, because
 * the layout pass needs an aspect ratio and a `viewBox` is one. Calling the
 * fields `widthPx`/`heightPx` keeps the two kinds interchangeable where the
 * layout only wants a shape — and the places that must tell them apart are
 * exactly the places that call `page.image` or `page.vector`.
 */
export type DrawableVector = {
  widthPx: number
  heightPx: number
  /** The sanitised document, as `sanitizeSvg` rewrote it at upload. */
  svg: string
}

/**
 * What a prepared asset turned out to be.
 *
 * Two successes rather than one, because a PDF has two unrelated ways to put a
 * picture on a page: an image XObject with pixels in it, and path operators in
 * the content stream. An SVG is the second, and a union that pretended
 * otherwise would make `kind` something each caller guessed from the content
 * type — which is the same question answered in several places, again.
 */
export type ImageResult =
  | { ok: true; kind: 'raster'; image: EmbeddableImage }
  | { ok: true; kind: 'vector'; vector: DrawableVector }
  | { ok: false; refusal: ImageRefusal }

/** Formats this can embed, as content types. The rest refuse by name. */
export const EMBEDDABLE_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const

/** Formats this can draw as paths. One, and it is the point of Phase 190. */
export const DRAWABLE_CONTENT_TYPES = ['image/svg+xml'] as const

/**
 * How big a picture is, without preparing it (Phase 186).
 *
 * Reads headers and nothing else — an IHDR, an SOF, a VP8 frame header, a GIF
 * logical screen descriptor — so it is cheap enough to run on every upload and
 * does not care whether the format can be embedded.
 *
 * **It answers for WebP and GIF, which `prepareImage` refuses.** That looks
 * inconsistent and is the point: a size is a fact about the file, and the web
 * page can crop a WebP perfectly well even though the PDF cannot print it. Tying
 * the two together would have made the browser's crop depend on what a printer
 * can do.
 *
 * `assets.width` and `assets.height` have existed since Phase 4 carrying the
 * comment *"Pixel dimensions when known, so layout can reserve space"*, and
 * nothing has ever written them or read them — Phase 49's rule twice over. They
 * are written now because a crop on the web is not expressible without them: the
 * cropped box has to take the cropped shape, and CSS can only work that out from
 * the source's aspect ratio.
 */
export function imageSize(
  bytes: Buffer,
  contentType: string,
): { width: number; height: number } | null {
  if (contentType === 'image/png') return pngSize(bytes)
  if (contentType === 'image/jpeg') return jpegSize(bytes)
  if (contentType === 'image/webp') return webpSize(bytes)
  if (contentType === 'image/gif') return gifSize(bytes)

  /*
    An SVG has no pixels, and its `viewBox` is the size it is drawn at by
    default — which is the number every other branch here returns and the
    number a crop is a fraction of. `readSvg` rather than a regular expression
    over the markup, because the `viewBox`-then-`width`/`height` fallback is a
    rule, and two readers of a rule is how they come to disagree.
  */
  if (contentType === 'image/svg+xml') {
    const read = readSvg(bytes.toString('utf8'))
    if ('refusal' in read) return null
    return { width: Math.round(read.viewBox[2]), height: Math.round(read.viewBox[3]) }
  }

  return null
}

function pngSize(bytes: Buffer) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null

  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function jpegSize(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1
      continue
    }

    const marker = bytes[at + 1]
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }

    // Every SOF carries the size, progressive and arithmetic included. This is
    // not `prepareImage`'s question — those refuse there and still have a size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(at + 5)
      const width = bytes.readUInt16BE(at + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }

    at += 2 + bytes.readUInt16BE(at + 2)
  }

  return null
}

function webpSize(bytes: Buffer) {
  if (bytes.length < 30) return null
  if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF') return null
  if (bytes.subarray(8, 12).toString('latin1') !== 'WEBP') return null

  const chunk = bytes.subarray(12, 16).toString('latin1')

  // Three containers, because WebP has three. `VP8X` is the extended header a
  // browser writes for anything with transparency or animation, which is most
  // of what a `toDataURL` produces.
  if (chunk === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  }

  if (chunk === 'VP8 ') {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }

  if (chunk === 'VP8L') {
    const packed = bytes.readUInt32LE(21)
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    }
  }

  return null
}

function gifSize(bytes: Buffer) {
  if (bytes.length < 10) return null
  const magic = bytes.subarray(0, 6).toString('latin1')
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null

  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

export function prepareImage(bytes: Buffer, contentType: string): ImageResult {
  if (contentType === 'image/jpeg') return readJpeg(bytes)
  if (contentType === 'image/png') return readPng(bytes)

  /*
    An SVG is not decoded, embedded or rasterised — it is **re-read** (Phase
    190). The bytes in the store were written by `sanitizeSvg`, so reading them
    with the same module's reader is the check that they still are what it
    wrote; an SVG that fails here is one that did not come through the upload
    path, and it refuses rather than draws.
  */
  if (contentType === 'image/svg+xml') {
    const read = readSvg(bytes.toString('utf8'))
    if ('refusal' in read) {
      return { ok: false, refusal: read.refusal }
    }

    return {
      ok: true,
      kind: 'vector',
      vector: {
        widthPx: read.viewBox[2],
        heightPx: read.viewBox[3],
        svg: bytes.toString('utf8'),
      },
    }
  }

  /*
    WebP and GIF reach here, and the asset library accepts both. Named rather
    than lumped into "unsupported", because the two are different conversions in
    a person's head: a GIF is usually an old logo and a WebP is usually a recent
    download, and both convert in any image editor.
  */
  return {
    ok: false,
    refusal: {
      reason: `${contentType} cannot be placed in a PDF`,
      remedy: 'Convert it to PNG or JPEG and upload it again.',
    },
  }
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** Markers that carry a frame header, by whether `/DCTDecode` renders them. */
const BASELINE_SOF = new Set([0xc0, 0xc1])
const OTHER_SOF = new Set([0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/**
 * Reads a JPEG's frame header and embeds the file unchanged.
 *
 * The only thing to find is the SOF segment, which gives height, width and
 * component count — the three numbers the XObject dictionary needs. The pixels
 * are never looked at.
 *
 * **Progressive JPEGs refuse.** `/DCTDecode` is specified to accept them and
 * real viewers disagree about it, and a proposal that renders in one PDF reader
 * and not another is worse than one that says so up front. Baseline is what a
 * camera, a phone and every "save for web" produces.
 */
function readJpeg(bytes: Buffer): ImageResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return notAnImage('JPEG')
  }

  let at = 2
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1
      continue
    }

    const marker = bytes[at + 1]

    // Padding and the standalone markers carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }

    const length = bytes.readUInt16BE(at + 2)

    if (BASELINE_SOF.has(marker)) {
      if (at + 9 >= bytes.length) return truncated('JPEG')

      const bitsPerComponent = bytes[at + 4]
      const heightPx = bytes.readUInt16BE(at + 5)
      const widthPx = bytes.readUInt16BE(at + 7)
      const components = bytes[at + 9]

      const colorSpace =
        components === 1 ? '/DeviceGray' : components === 3 ? '/DeviceRGB' : null

      if (!colorSpace) {
        /*
          Four components is CMYK, and a CMYK JPEG is usually print-shop output
          whose Adobe APP14 marker says whether the values are inverted. Getting
          that wrong prints a photographic negative, which is a worse outcome
          than a placeholder, so it refuses.
        */
        return {
          ok: false,
          refusal: {
            reason: `this JPEG has ${components} colour channels`,
            remedy: 'Re-save it as an RGB or greyscale JPEG, or as a PNG.',
          },
        }
      }

      if (widthPx === 0 || heightPx === 0) return notAnImage('JPEG')

      return {
        ok: true,
        kind: 'raster',
        image: {
          widthPx,
          heightPx,
          colorSpace,
          bitsPerComponent,
          filter: 'DCTDecode',
          // Byte for byte. Nothing is decoded and nothing is re-encoded, so
          // what the client sees is the file somebody uploaded.
          data: bytes,
          decodeParms: null,
          smask: null,
        },
      }
    }

    if (OTHER_SOF.has(marker)) {
      return {
        ok: false,
        refusal: {
          reason: 'this JPEG is progressive or uses arithmetic coding',
          remedy: 'Re-save it as a baseline JPEG, or as a PNG.',
        },
      }
    }

    at += 2 + length
  }

  return truncated('JPEG')
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels per pixel, by PNG colour type. Index 1 and 5 do not exist. */
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * Reads a PNG, and passes its compressed rows through where it can.
 *
 * Three of the five colour types embed with no decompression at all:
 * greyscale, truecolour and palette. Their `IDAT` is already a Flate stream of
 * predictor-filtered rows, which is precisely what `/Predictor 15` means in a
 * PDF `/DecodeParms` — the PDF specification adopted the PNG filter set.
 *
 * The two with alpha are the work, because PDF holds transparency in a separate
 * image. They are inflated, unfiltered, split, and re-deflated.
 *
 * **Interlaced PNGs refuse.** Adam7 reorders the pixels into seven passes, so
 * the predictor no longer describes the rows and the stream cannot be passed
 * through. De-interlacing is a decoder, and this is deliberately not one.
 */
function readPng(bytes: Buffer): ImageResult {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return notAnImage('PNG')
  }

  let widthPx = 0
  let heightPx = 0
  let bitDepth = 0
  let colorType = -1
  let interlace = 0
  let palette: Buffer | null = null
  let paletteAlpha: Buffer | null = null
  const idat: Buffer[] = []

  let at = 8
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at)
    const kind = bytes.subarray(at + 4, at + 8).toString('latin1')
    const start = at + 8
    const end = start + length

    if (end > bytes.length) return truncated('PNG')

    if (kind === 'IHDR') {
      if (length < 13) return truncated('PNG')
      widthPx = bytes.readUInt32BE(start)
      heightPx = bytes.readUInt32BE(start + 4)
      bitDepth = bytes[start + 8]
      colorType = bytes[start + 9]
      interlace = bytes[start + 12]
    } else if (kind === 'PLTE') {
      palette = bytes.subarray(start, end)
    } else if (kind === 'tRNS') {
      paletteAlpha = bytes.subarray(start, end)
    } else if (kind === 'IDAT') {
      idat.push(bytes.subarray(start, end))
    } else if (kind === 'IEND') {
      break
    }

    at = end + 4
  }

  if (widthPx === 0 || heightPx === 0 || idat.length === 0) return notAnImage('PNG')

  const channels = PNG_CHANNELS[colorType]
  if (channels === undefined) return notAnImage('PNG')

  if (interlace !== 0) {
    return {
      ok: false,
      refusal: {
        reason: 'this PNG is interlaced',
        remedy: 'Re-save it without interlacing, or as a JPEG.',
      },
    }
  }

  if (colorType === 3 && !palette) return notAnImage('PNG')

  /*
    A palette with a `tRNS` chunk has per-entry transparency, which PDF
    expresses with `/Mask` on the indices rather than an `/SMask` — a different
    mechanism from the one below, and one whose common use is a single
    fully-transparent entry. Refused rather than half-built: a logo that renders
    with a black background instead of a transparent one is the failure mode,
    and it is the exact failure a person would not notice until a client did.
  */
  if (colorType === 3 && paletteAlpha) {
    return {
      ok: false,
      refusal: {
        reason: 'this PNG uses a transparent palette entry',
        remedy: 'Re-save it as a 24-bit or 32-bit PNG.',
      },
    }
  }

  const stream = Buffer.concat(idat)

  // Greyscale, truecolour and palette: the rows go through untouched.
  if (colorType === 0 || colorType === 2 || colorType === 3) {
    const colorSpace =
      colorType === 3
        ? `[/Indexed /DeviceRGB ${palette!.length / 3 - 1} <${palette!.toString('hex')}>]`
        : colorType === 0
          ? '/DeviceGray'
          : '/DeviceRGB'

    return {
      ok: true,
      kind: 'raster',
      image: {
        widthPx,
        heightPx,
        colorSpace,
        bitsPerComponent: bitDepth,
        filter: 'FlateDecode',
        data: stream,
        /*
          `/Predictor 15` is "the PNG filter set, chosen per row", which is what
          every PNG row's leading byte already says. `/Colors` is the channel
          count the predictor needs to know the pixel stride, and for a palette
          it is 1, because an index is one sample.
        */
        decodeParms:
          `<< /Predictor 15 /Colors ${colorType === 2 ? 3 : 1} ` +
          `/BitsPerComponent ${bitDepth} /Columns ${widthPx} >>`,
        smask: null,
      },
    }
  }

  // Greyscale+alpha and RGBA: the one case that is really decoded.
  if (bitDepth !== 8 && bitDepth !== 16) {
    return {
      ok: false,
      refusal: {
        reason: `this PNG has transparency at ${bitDepth} bits per channel`,
        remedy: 'Re-save it at 8 bits per channel.',
      },
    }
  }

  const bytesPerSample = bitDepth / 8
  const colorChannels = colorType === 4 ? 1 : 3

  let raw: Buffer
  try {
    raw = unfilter(inflateSync(stream), {
      widthPx,
      heightPx,
      channels,
      bytesPerSample,
    })
  } catch {
    return {
      ok: false,
      refusal: {
        reason: 'this PNG could not be read',
        remedy: 'Re-save it from an image editor and upload it again.',
      },
    }
  }

  const pixelBytes = channels * bytesPerSample
  const colorBytes = colorChannels * bytesPerSample
  const color = Buffer.allocUnsafe(widthPx * heightPx * colorBytes)
  const alpha = Buffer.allocUnsafe(widthPx * heightPx * bytesPerSample)

  for (let pixel = 0; pixel < widthPx * heightPx; pixel += 1) {
    const from = pixel * pixelBytes
    raw.copy(color, pixel * colorBytes, from, from + colorBytes)
    raw.copy(alpha, pixel * bytesPerSample, from + colorBytes, from + pixelBytes)
  }

  return {
    ok: true,
    kind: 'raster',
    image: {
      widthPx,
      heightPx,
      colorSpace: colorChannels === 1 ? '/DeviceGray' : '/DeviceRGB',
      bitsPerComponent: bitDepth,
      filter: 'FlateDecode',
      // Re-deflated without a predictor: the rows are already unfiltered, and
      // re-applying one would be work for a byte or two.
      data: deflateSync(color),
      decodeParms: null,
      smask: {
        widthPx,
        heightPx,
        bitsPerComponent: bitDepth,
        data: deflateSync(alpha),
      },
    },
  }
}

/**
 * Reverses the PNG row filters.
 *
 * Five of them, applied per row and named by the row's first byte. The
 * arithmetic is bytewise and modulo 256 rather than per-sample, which is what
 * the PNG specification says and is the detail a first attempt usually gets
 * wrong at 16 bits per channel.
 */
function unfilter(
  filtered: Buffer,
  shape: { widthPx: number; heightPx: number; channels: number; bytesPerSample: number },
): Buffer {
  const stride = shape.widthPx * shape.channels * shape.bytesPerSample
  const step = shape.channels * shape.bytesPerSample

  if (filtered.length < shape.heightPx * (stride + 1)) {
    throw new Error('PNG data is shorter than its header claims')
  }

  const out = Buffer.allocUnsafe(shape.heightPx * stride)

  for (let row = 0; row < shape.heightPx; row += 1) {
    const kind = filtered[row * (stride + 1)]
    const from = row * (stride + 1) + 1
    const to = row * stride

    for (let at = 0; at < stride; at += 1) {
      const value = filtered[from + at]
      const left = at >= step ? out[to + at - step] : 0
      const up = row > 0 ? out[to - stride + at] : 0
      const upLeft = row > 0 && at >= step ? out[to - stride + at - step] : 0

      out[to + at] =
        (value +
          (kind === 0
            ? 0
            : kind === 1
              ? left
              : kind === 2
                ? up
                : kind === 3
                  ? (left + up) >> 1
                  : paeth(left, up, upLeft))) &
        0xff
    }
  }

  return out
}

/** The Paeth predictor: whichever neighbour the gradient is closest to. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const dl = Math.abs(estimate - left)
  const du = Math.abs(estimate - up)
  const dul = Math.abs(estimate - upLeft)

  return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft
}

function notAnImage(format: string): ImageResult {
  return {
    ok: false,
    refusal: {
      reason: `this file is not a readable ${format}`,
      remedy: 'Re-save it from an image editor and upload it again.',
    },
  }
}

function truncated(format: string): ImageResult {
  return {
    ok: false,
    refusal: {
      reason: `this ${format} is incomplete`,
      remedy: 'Upload the whole file again — the stored copy is truncated.',
    },
  }
}
