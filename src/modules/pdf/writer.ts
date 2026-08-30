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
 * Not a general PDF library. No embedded fonts, no transparency, no images
 * beyond a placeholder frame, no encryption, no tagged/accessible structure.
 * Those are named in the ADR's consequences rather than half-built here.
 */

export type Rgb = { r: number; g: number; b: number }

/** `#0d6e60` → components in 0–1, which is what PDF operators take. */
export function parseColor(hex: string, fallback: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return fallback

  const value = parseInt(match[1], 16)
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

  content(): string {
    return this.ops.join('\n')
  }
}

export type PdfDocumentInput = {
  pages: PageCanvas[]
  title: string
  author: string
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
 * cross-reference table. Streams are stored uncompressed — a proposal is a few
 * kilobytes of text, and an uncompressed file is one a person can read in a
 * text editor when something looks wrong, which has already paid for itself.
 */
export function writePdf(input: PdfDocumentInput): Buffer {
  const fonts = Object.entries(FONT_RESOURCE)
  const objects: string[] = []

  // Object numbering, fixed so the offsets can be computed in one pass:
  //   1        catalog
  //   2        page tree
  //   3        info
  //   4..10    fonts
  //   11..     page, content, page, content, …
  const FIRST_FONT = 4
  const FIRST_PAGE = FIRST_FONT + fonts.length

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

  const resources =
    `<< /Font << ${fonts
      .map(([, resource], index) => `/${resource} ${FIRST_FONT + index} 0 R`)
      .join(' ')} >> >>`

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
