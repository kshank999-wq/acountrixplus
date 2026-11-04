import { OUR_NAME } from '@/modules/brand/voice'
import { toWinAnsi, widthOf, type StandardFont } from './metrics'

/**
 * A minimal, deterministic PDF 1.4 writer (spec §18 "server-side PDF
 * generation", §7 "PDF export, print-quality output").
 *
 * ## Why this exists rather than a headless browser
 *
 * ADR 0004 deferred server-side PDF with a real choice: *"either a headless
 * browser in the deployment or a layout library re-implementing pagination the
 * browser already does."* Phase 21 needs a third property neither option was
 * judged on, and it settles the question.
 *
 * **The output has to be deterministic.** The claim this phase makes is that a
 * proposal a client was sent never changes, and the proof is that the bytes
 * hash to the same digest. A browser cannot make that promise: Chromium stamps
 * a producer string and a creation date into every file, and its text shaping
 * changes between versions. Upgrading the browser would silently rewrite every
 * historical document.
 *
 * So: no clock, no randomness, no external process. The same input produces the
 * same bytes, and `tests/pdf.test.ts` asserts it. The creation date is passed
 * in — it is the moment the proposal was *sent*, which is the honest value
 * anyway.
 *
 * ## What it is not
 *
 * Not a general PDF library. No embedded fonts, no encryption, no
 * tagged/accessible structure. Those are named in the ADR's consequences rather
 * than half-built here.
 *
 * It said "no images beyond a placeholder frame" until Phase 185, and that
 * sentence is why the gap survived: it was a declared limit rather than a
 * hidden one, so nobody read it as a defect. It was one — the PDF is what a
 * client prints and files, and the company logo reached it as an empty box.
 * Images are embedded now, and transparency with them, because PDF speaks JPEG
 * and PNG natively and neither needed a decoder.
 */

import type { EmbeddableImage } from './images'
import { ROUNDED_MASK_FRACTION } from '@/modules/design/blocks'

export type Rgb = { r: number; g: number; b: number }

/**
 * `#0d6e60` → components in 0–1, which is what PDF operators take.
 *
 * Three-digit hex counts, since Phase 79. `isHexColor` in `studio/service` —
 * the guard on the only way a brand colour gets stored — accepts `#fff` and
 * always has, and CSS understands it, so the Design Center took it, the
 * browser drew the document in it, and the PDF writer silently rejected it and
 * fell through to a default. Two answers to "what is a hex colour", with the
 * disagreement landing on paper.
 */
export function parseColor(hex: string, fallback: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return fallback

  // `#abc` is `#aabbcc`, which is a doubling rather than a padding: `#abc` is
  // not `#0a0b0c`.
  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : match[1]

  const value = parseInt(digits, 16)
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  }
}

const FONT_RESOURCE: Record<StandardFont, string> = {
  Helvetica: 'F1',
  'Helvetica-Bold': 'F2',
  'Helvetica-Oblique': 'F3',
  'Times-Roman': 'F4',
  'Times-Bold': 'F5',
  'Times-Italic': 'F6',
  Courier: 'F7',
}

/**
 * One page's drawing operations, in PDF user space.
 *
 * The origin is the bottom-left corner, which is why every caller works in
 * "points down from the top" and converts once, here. Getting that conversion
 * scattered through the layout code is how a footer ends up above the header.
 */
export class PageCanvas {
  private readonly ops: string[] = []
  private readonly placed = new Set<string>()

  constructor(
    readonly widthPt: number,
    readonly heightPt: number,
  ) {}

  /** Draws one line of text. `y` is measured down from the top of the page. */
  text(
    value: string,
    options: { x: number; y: number; font: StandardFont; size: number; color?: Rgb },
  ): void {
    const safe = toWinAnsi(value)
    if (!safe) return

    const color = options.color ?? { r: 0, g: 0, b: 0 }
    // The baseline sits `size` below the top of the line box, which is close
    // enough to the cap height for business text and keeps the arithmetic in
    // the layout pass simple.
    const baseline = this.heightPt - options.y - options.size

    this.ops.push(
      'BT',
      `${fixed(color.r)} ${fixed(color.g)} ${fixed(color.b)} rg`,
      `/${FONT_RESOURCE[options.font]} ${fixed(options.size)} Tf`,
      `1 0 0 1 ${fixed(options.x)} ${fixed(baseline)} Tm`,
      `(${escapeString(safe)}) Tj`,
      'ET',
    )
  }

  /** A filled rectangle. Used for rules, table banding, and cover panels. */
  rect(options: {
    x: number
    y: number
    width: number
    height: number
    color: Rgb
  }): void {
    if (options.width <= 0 || options.height <= 0) return

    const bottom = this.heightPt - options.y - options.height
    this.ops.push(
      'q',
      `${fixed(options.color.r)} ${fixed(options.color.g)} ${fixed(options.color.b)} rg`,
      `${fixed(options.x)} ${fixed(bottom)} ${fixed(options.width)} ${fixed(options.height)} re`,
      'f',
      'Q',
    )
  }

  /** A stroked rectangle, for image placeholders and signature boxes. */
  frame(options: {
    x: number
    y: number
    width: number
    height: number
    color: Rgb
    lineWidth?: number
  }): void {
    if (options.width <= 0 || options.height <= 0) return

    const bottom = this.heightPt - options.y - options.height
    this.ops.push(
      'q',
      `${fixed(options.color.r)} ${fixed(options.color.g)} ${fixed(options.color.b)} RG`,
      `${fixed(options.lineWidth ?? 0.75)} w`,
      `${fixed(options.x)} ${fixed(bottom)} ${fixed(options.width)} ${fixed(options.height)} re`,
      'S',
      'Q',
    )
  }

  /**
   * Places an image XObject (Phase 185).
   *
   * `name` is the resource key `writePdf` assigned, so this method knows
   * nothing about pictures — it writes a transform and an invocation, which is
   * all the content stream ever says about an image.
   *
   * The `cm` matrix is `width 0 0 height x y`: a PDF image XObject is defined
   * on a one-by-one unit square, so the scale *is* the size on the page and
   * there is no resolution anywhere in here. A 4000-pixel photograph placed at
   * 200 points is 200 points of 4000 pixels, which is what makes it print well.
   *
   * `clip` is a region in page coordinates. Given, the image is drawn to
   * `width`/`height` as usual and only the clipped part shows — which is how a
   * crop works in a PDF: a path, `W n`, and the picture is never altered.
   *
   * Its `shape` is §7's *mask* (Phase 186). A rectangle is the crop on its own;
   * `rounded` and `circle` are the two outlines a business document asks for,
   * and both are four Bézier curves. An arbitrary mask is a path, which is the
   * vector authoring §7 defers.
   */
  image(options: {
    name: string
    x: number
    y: number
    width: number
    height: number
    clip?: {
      x: number
      y: number
      width: number
      height: number
      shape?: 'rect' | 'rounded' | 'circle'
    }
  }): void {
    if (options.width <= 0 || options.height <= 0) return

    this.placed.add(options.name)

    const bottom = this.heightPt - options.y - options.height
    this.ops.push('q')

    if (options.clip) {
      const clipBottom = this.heightPt - options.clip.y - options.clip.height
      this.ops.push(
        ...clipPath({
          x: options.clip.x,
          y: clipBottom,
          width: options.clip.width,
          height: options.clip.height,
          shape: options.clip.shape ?? 'rect',
        }),
        'W',
        'n',
      )
    }

    this.ops.push(
      `${fixed(options.width)} 0 0 ${fixed(options.height)} ` +
        `${fixed(options.x)} ${fixed(bottom)} cm`,
      `/${options.name} Do`,
      'Q',
    )
  }

  /**
   * The image resources this page actually invokes.
   *
   * Recorded rather than inferred, because the caller's claim is that an
   * unplaced picture is not in the file and an inferred answer would make that
   * claim true by assumption. A first version embedded every prepared image
   * whether or not a block placed it, and the comment above it said otherwise;
   * the test caught the comment.
   */
  usedImages(): ReadonlySet<string> {
    return this.placed
  }

  content(): string {
    return this.ops.join('\n')
  }
}

export type PdfDocumentInput = {
  pages: PageCanvas[]
  title: string
  author: string
  /**
   * The images any page places, by the resource name it places them under
   * (Phase 185).
   *
   * A map rather than a list, because a logo on nine pages is one XObject
   * invoked nine times and a list would need the caller to deduplicate — which
   * is the caller discovering that a PDF stores pictures once.
   */
  images?: Map<string, EmbeddableImage>
  /**
   * Stamped as the creation and modification date.
   *
   * Required rather than defaulted to `new Date()`, which is the single
   * decision that makes the output reproducible. A default would be used by
   * accident exactly once and the immutability claim would be quietly false.
   */
  createdAt: Date
}

/**
 * Serialises pages into a PDF file.
 *
 * Written by hand because the structure is small: a catalog, a page tree, one
 * content stream per page, seven font objects, an info dictionary, and a
 * cross-reference table. Content streams are stored uncompressed — a proposal
 * is a few kilobytes of text, and an uncompressed file is one a person can read
 * in a text editor when something looks wrong, which has already paid for
 * itself.
 *
 * **Image streams are the exception and are binary** (Phase 185). The file is
 * assembled as `latin1`, which maps each code unit 0–255 to exactly one byte,
 * so arbitrary bytes pass through a string unharmed — the same property the
 * binary comment line below has always relied on. That is why embedding images
 * needed no restructuring here.
 */
export function writePdf(input: PdfDocumentInput): Buffer {
  const fonts = Object.entries(FONT_RESOURCE)
  const objects: string[] = []

  /*
    Object numbering, fixed so the offsets can be computed in one pass:
      1                catalog
      2                page tree
      3                info
      4..10            fonts
      11..             images, and a soft mask after each that has one
      then             page, content, page, content, …

    Images come before the pages because a page's `/Resources` has to name
    them, and the resource dictionary is built once and shared.
  */
  const FIRST_FONT = 4
  const FIRST_IMAGE = FIRST_FONT + fonts.length

  const images = [...(input.images ?? new Map()).entries()]

  // Two objects for an image with transparency: the picture, then its mask.
  const imageIds = new Map<string, { id: number; maskId: number | null }>()
  let nextId = FIRST_IMAGE
  for (const [name, image] of images) {
    const id = nextId
    nextId += 1
    const maskId = image.smask ? nextId : null
    if (maskId !== null) nextId += 1
    imageIds.set(name, { id, maskId })
  }

  const FIRST_PAGE = nextId
  const pageIds = input.pages.map((_, index) => FIRST_PAGE + index * 2)

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] =
    `<< /Type /Pages /Count ${input.pages.length} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  objects[3] =
    `<< /Title (${escapeString(toWinAnsi(input.title))}) ` +
    `/Author (${escapeString(toWinAnsi(input.author))}) ` +
    `/Producer (${escapeString(toWinAnsi(OUR_NAME))}) ` +
    `/CreationDate (${pdfDate(input.createdAt)}) ` +
    `/ModDate (${pdfDate(input.createdAt)}) >>`

  fonts.forEach(([name], index) => {
    objects[FIRST_FONT + index] =
      `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`
  })

  for (const [name, image] of images) {
    const { id, maskId } = imageIds.get(name)!

    if (maskId !== null && image.smask) {
      /*
        The alpha channel as its own greyscale image. PDF keeps transparency
        beside the picture rather than inside it, which is why a PNG with alpha
        is the one format here that is really decoded: the colour and the alpha
        have to be separated before either can be written.
      */
      objects[maskId] = imageObject({
        widthPx: image.smask.widthPx,
        heightPx: image.smask.heightPx,
        colorSpace: '/DeviceGray',
        bitsPerComponent: image.smask.bitsPerComponent,
        filter: 'FlateDecode',
        decodeParms: null,
        smaskRef: null,
        data: image.smask.data,
      })
    }

    objects[id] = imageObject({
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      colorSpace: image.colorSpace,
      bitsPerComponent: image.bitsPerComponent,
      filter: image.filter,
      decodeParms: image.decodeParms,
      smaskRef: maskId,
      data: image.data,
    })
  }

  const resources =
    `<< /Font << ${fonts
      .map(([, resource], index) => `/${resource} ${FIRST_FONT + index} 0 R`)
      .join(' ')} >>` +
    (images.length > 0
      ? ` /XObject << ${images
          .map(([name]) => `/${name} ${imageIds.get(name)!.id} 0 R`)
          .join(' ')} >>`
      : '') +
    ` >>`

  input.pages.forEach((page, index) => {
    const pageId = pageIds[index]
    const contentId = pageId + 1
    const stream = page.content()

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 ${fixed(page.widthPt)} ${fixed(page.heightPt)}] ` +
      `/Resources ${resources} /Contents ${contentId} 0 R >>`

    // Byte length, not character length: the escaped string may contain
    // multi-byte sequences if a fold ever lets one through.
    objects[contentId] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  const highestUsed = Math.max(nextId - 1, ...pageIds.map((id) => id + 1), 3)
  objects.length = Math.max(objects.length, highestUsed + 1)

  const chunks: string[] = ['%PDF-1.4\n']
  // A binary comment line, so tools that sniff text-versus-binary treat the
  // file as binary and do not mangle line endings in transit.
  chunks.push('%\xE2\xE3\xCF\xD3\n')

  const offsets: number[] = []
  let position = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk, 'latin1'), 0)

  const highest = objects.length - 1
  for (let id = 1; id <= highest; id += 1) {
    const body = objects[id]
    if (body === undefined) continue

    offsets[id] = position
    const serialized = `${id} 0 obj\n${body}\nendobj\n`
    chunks.push(serialized)
    position += Buffer.byteLength(serialized, 'latin1')
  }

  const xrefStart = position
  const rows: string[] = ['xref\n', `0 ${highest + 1}\n`, '0000000000 65535 f \n']

  for (let id = 1; id <= highest; id += 1) {
    rows.push(
      offsets[id] === undefined
        ? '0000000000 65535 f \n'
        : `${String(offsets[id]).padStart(10, '0')} 00000 n \n`,
    )
  }

  chunks.push(rows.join(''))
  chunks.push(
    `trailer\n<< /Size ${highest + 1} /Root 1 0 R /Info 3 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`,
  )

  return Buffer.from(chunks.join(''), 'latin1')
}

/**
 * How far a Bézier control point sits along the tangent to approximate a
 * quarter arc.
 *
 * `4/3 × (√2 − 1)`. The standard constant, written as the arithmetic rather
 * than as `0.5523` so a reader can see it is derived and not tuned.
 */
const KAPPA = (4 / 3) * (Math.SQRT2 - 1)

/**
 * The operators for a clipping region, in PDF coordinates (`y` upward).
 *
 * A rectangle is one operator. The other two are four curves, and a circle in
 * a non-square box is an **ellipse** — which is the right generalisation,
 * because that is what `border-radius: 50%` does on the page and the two
 * renderers have to agree about the shape.
 */
function clipPath(box: {
  x: number
  y: number
  width: number
  height: number
  shape: 'rect' | 'rounded' | 'circle'
}): string[] {
  const { x, y, width, height } = box

  if (box.shape === 'rect') {
    return [`${fixed(x)} ${fixed(y)} ${fixed(width)} ${fixed(height)} re`]
  }

  if (box.shape === 'circle') {
    const rx = width / 2
    const ry = height / 2
    const cx = x + rx
    const cy = y + ry
    const kx = rx * KAPPA
    const ky = ry * KAPPA

    return [
      `${fixed(cx + rx)} ${fixed(cy)} m`,
      `${fixed(cx + rx)} ${fixed(cy + ky)} ${fixed(cx + kx)} ${fixed(cy + ry)} ${fixed(cx)} ${fixed(cy + ry)} c`,
      `${fixed(cx - kx)} ${fixed(cy + ry)} ${fixed(cx - rx)} ${fixed(cy + ky)} ${fixed(cx - rx)} ${fixed(cy)} c`,
      `${fixed(cx - rx)} ${fixed(cy - ky)} ${fixed(cx - kx)} ${fixed(cy - ry)} ${fixed(cx)} ${fixed(cy - ry)} c`,
      `${fixed(cx + kx)} ${fixed(cy - ry)} ${fixed(cx + rx)} ${fixed(cy - ky)} ${fixed(cx + rx)} ${fixed(cy)} c`,
      'h',
    ]
  }

  // Rounded: the same fraction of the shorter side that the page's CSS uses,
  // so a corner is the same corner in both.
  const r = Math.min(width, height) * ROUNDED_MASK_FRACTION
  const k = r * KAPPA

  return [
    `${fixed(x + r)} ${fixed(y)} m`,
    `${fixed(x + width - r)} ${fixed(y)} l`,
    `${fixed(x + width - r + k)} ${fixed(y)} ${fixed(x + width)} ${fixed(y + r - k)} ${fixed(x + width)} ${fixed(y + r)} c`,
    `${fixed(x + width)} ${fixed(y + height - r)} l`,
    `${fixed(x + width)} ${fixed(y + height - r + k)} ${fixed(x + width - r + k)} ${fixed(y + height)} ${fixed(x + width - r)} ${fixed(y + height)} c`,
    `${fixed(x + r)} ${fixed(y + height)} l`,
    `${fixed(x + r - k)} ${fixed(y + height)} ${fixed(x)} ${fixed(y + height - r + k)} ${fixed(x)} ${fixed(y + height - r)} c`,
    `${fixed(x)} ${fixed(y + r)} l`,
    `${fixed(x)} ${fixed(y + r - k)} ${fixed(x + r - k)} ${fixed(y)} ${fixed(x + r)} ${fixed(y)} c`,
    'h',
  ]
}

/**
 * One image XObject, dictionary and stream.
 *
 * `latin1` throughout: the stream is binary and the file is assembled as a
 * `latin1` string, which is byte-for-byte faithful for every value 0–255.
 */
function imageObject(input: {
  widthPx: number
  heightPx: number
  colorSpace: string
  bitsPerComponent: number
  filter: string
  decodeParms: string | null
  smaskRef: number | null
  data: Buffer
}): string {
  const dictionary =
    `<< /Type /XObject /Subtype /Image ` +
    `/Width ${input.widthPx} /Height ${input.heightPx} ` +
    `/ColorSpace ${input.colorSpace} ` +
    `/BitsPerComponent ${input.bitsPerComponent} ` +
    `/Filter /${input.filter} ` +
    (input.decodeParms ? `/DecodeParms ${input.decodeParms} ` : '') +
    (input.smaskRef !== null ? `/SMask ${input.smaskRef} 0 R ` : '') +
    `/Length ${input.data.length} >>`

  return `${dictionary}\nstream\n${input.data.toString('latin1')}\nendstream`
}

/**
 * Breaks text into lines that fit a width.
 *
 * A word longer than the line — a URL, usually — is placed alone and allowed
 * to overflow rather than being chopped mid-character. Splitting a URL across
 * lines makes it un-clickable and un-typeable, which is worse than a margin
 * that is slightly wrong on one line.
 */
export function wrapText(
  text: string,
  options: { font: StandardFont; size: number; maxWidth: number },
): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)

    if (words.length === 0) {
      lines.push('')
      continue
    }

    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word

      if (widthOf(candidate, options.font, options.size) <= options.maxWidth || !current) {
        current = candidate
        continue
      }

      lines.push(current)
      current = word
    }

    if (current) lines.push(current)
  }

  return lines
}

/** Shortens to fit, with an ellipsis, for a table cell that must not wrap. */
export function truncateToWidth(
  text: string,
  options: { font: StandardFont; size: number; maxWidth: number },
): string {
  if (widthOf(text, options.font, options.size) <= options.maxWidth) return text

  let cut = text
  while (cut.length > 1 && widthOf(`${cut}...`, options.font, options.size) > options.maxWidth) {
    cut = cut.slice(0, -1)
  }

  return `${cut.trimEnd()}...`
}

/**
 * Fixed to three decimals, and `-0` collapsed.
 *
 * The rounding is what makes the output stable: floating-point drift in a
 * layout calculation would otherwise change the bytes without changing the
 * document, and the digest is load-bearing here.
 */
function fixed(value: number): string {
  const rounded = Number(value.toFixed(3))
  return String(rounded === 0 ? 0 : rounded)
}

/** Escapes the three characters that are special inside a PDF string. */
function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** `D:YYYYMMDDHHmmSSZ` — the PDF date format, always in UTC. */
function pdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')

  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}
