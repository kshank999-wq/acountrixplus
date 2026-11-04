import { isWholeImage, normalizeCrop, normalizeTable, type Block } from '@/modules/design/blocks'
import { selectTeam, type RenderedTeamMember } from '@/modules/studio/team'
import type { EmbeddableImage, ImageResult } from './images'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import { resolveMergeFields, type MergeContext } from '@/modules/design/merge-fields'
import {
  PageCanvas,
  parseColor,
  truncateToWidth,
  wrapText,
  writePdf,
  type Rgb,
} from './writer'
import { widthOf, type StandardFont } from './metrics'

/**
 * Turning a design document into pages (spec §7, §18).
 *
 * A pure function of its inputs — blocks, brand, line items, a timestamp — with
 * no database access and no clock. That is what lets a test render the same
 * document twice and assert the bytes are identical, which is the whole
 * evidence for "what the client was sent never changes".
 *
 * ## Pagination is measure-then-place
 *
 * Every block reports the height it needs before anything is drawn. A block
 * that does not fit the remaining space moves whole to the next page; a text
 * run that is taller than a page splits by line, because moving a two-page
 * paragraph whole would leave a blank page and then overflow anyway.
 *
 * The browser does this for the on-screen and print views and does it better.
 * This exists because the *server* has to produce the same document without a
 * browser, and because the output has to be reproducible — see `writer.ts`.
 */

export type BrandTokens = {
  primaryColor: string
  accentColor: string
  textColor: string
  mutedColor: string
  headingFont: string
  bodyFont: string
  baseSizePt: number
}

export type PricingLine = {
  description: string
  quantityMilli: number
  unitPriceCents: number
  amountCents: number
  isOptional: boolean
  isSelected: boolean
}

export type DocumentTotals = {
  subtotalCents: number
  discountCents: number
  taxCents: number
  totalCents: number
}

export type RenderInput = {
  blocks: Block[]
  brand: BrandTokens
  merge: MergeContext
  pageSize: 'letter' | 'a4' | 'legal'
  orientation: 'portrait' | 'landscape'
  headerText?: string | null
  footerText?: string | null
  /**
   * What has to be disclosed about the content (Phase 165, spec §11).
   *
   * Its own field rather than appended to `footerText`, and the reason is the
   * whole point: the footer is the author's to write, and **a disclosure the
   * author can edit out is not a disclosure.** Mixing a chosen string with a
   * mandatory fact would let somebody remove the second by editing the first.
   *
   * Drawn on its own line above the footer, in the same muted grey, because a
   * disclosure set apart in bold reads as a disclaimer and one hidden in the
   * footer text reads as nothing.
   */
  disclosureText?: string | null
  showPageNumbers: boolean
  /** Supplied by the caller so the figures cannot drift from the record. */
  lines?: PricingLine[]
  totals?: DocumentTotals
  /**
   * The firm's people, for a `team` block (Phase 183, §15).
   *
   * Supplied for the same reason as the lines above: the block holds ids, so a
   * bio cannot drift from the one copy in `team_members`.
   *
   * The document's whole pool; `selectTeam` picks each block's people out of it,
   * which is the same function the page and the email use.
   */
  team?: RenderedTeamMember[]
  /**
   * The pictures, by asset id, already prepared for embedding (Phase 185).
   *
   * Prepared by the caller rather than here, because reading bytes out of the
   * object store is a database and a network away and this function is pure —
   * `renderDocumentPdf` takes everything it needs and touches nothing.
   *
   * An asset the caller could not prepare is **present with its refusal**
   * rather than absent: absent means "the author placed no image", and those
   * two have to look different on the page. See `ImageResult`.
   */
  images?: Map<string, ImageResult>
  /**
   * The brand kit's logo, for a `cover` block's `showLogo` (Phase 185).
   *
   * Not on `BrandTokens`, which is the *style* the web renderer shares — a
   * colour, a font, a size. An asset id is a thing to fetch, and putting it
   * there would make every consumer of the tokens carry a reference it cannot
   * resolve.
   *
   * `showLogo` has been a toggle in the editor, honoured on the web page, and
   * **ignored here** since Phase 5. The same gap the `image` block had, in the
   * one block that is the first page a client sees.
   */
  logoAssetId?: string | null
  title: string
  author: string
  /** Stamped into the file. The send time, never `new Date()`. */
  createdAt: Date
}

const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  letter: { width: 612, height: 792 },
  a4: { width: 595, height: 842 },
  legal: { width: 612, height: 1008 },
}

/**
 * How big a headshot prints (Phase 185).
 *
 * A square, because a team directory of mixed portrait and landscape
 * photographs reads as a mistake, and because `object-fit: cover` on the web
 * page already squares them — two renderers disagreeing about the shape of a
 * person's face is the kind of difference a client notices.
 */
const SQUARE_HEADSHOT = 56

const MARGIN = 54
const HEADER_BAND = 34
const FOOTER_BAND = 34

/**
 * Maps a CSS font stack onto one of the standard 14.
 *
 * A brand kit names something like `Georgia, serif`. Only the generic family
 * survives into the PDF, because nothing is embedded — so a serif stack becomes
 * Times and everything else becomes Helvetica. It is a real limitation and it
 * is visible: a company's brand font does not reach the printed page.
 */
function familyFor(stack: string, bold = false, italic = false): StandardFont {
  const serif = /georgia|times|garamond|serif/i.test(stack) && !/sans-serif/i.test(stack)

  if (serif) {
    if (bold) return 'Times-Bold'
    if (italic) return 'Times-Italic'
    return 'Times-Roman'
  }

  if (bold) return 'Helvetica-Bold'
  if (italic) return 'Helvetica-Oblique'
  return 'Helvetica'
}

/** Cents as a plain figure. Money never becomes a float on the way here. */
function money(cents: number): string {
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const formatted = `${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(
    absolute % 100,
  ).padStart(2, '0')}`

  return negative ? `($${formatted})` : `$${formatted}`
}

/** Thousandths as a quantity somebody would write. */
function quantity(milli: number): string {
  if (milli % 1000 === 0) return String(milli / 1000)
  return (milli / 1000).toFixed(2).replace(/0$/, '')
}

/**
 * A drawing instruction with a known height, produced before any page exists.
 *
 * The two-pass shape is what makes pagination honest: nothing is placed until
 * the whole block's height is known, so a heading can never be orphaned at the
 * foot of a page from its first paragraph without the code noticing.
 */
type Piece = {
  height: number
  /** Draws at `y`, measured down from the top of the page's content area. */
  draw: (page: PageCanvas, y: number) => void
  /** Pieces that must stay with the next one — a heading, a table header. */
  keepWithNext?: boolean
  /** Draws nothing. Dropped when it would land at the top of a page. */
  spacer?: boolean
}

class Composer {
  private readonly pieces: Piece[] = []

  constructor(
    private readonly input: RenderInput,
    private readonly contentWidth: number,
    private readonly body: StandardFont,
    private readonly heading: StandardFont,
    private readonly headingBold: StandardFont,
    private readonly text: Rgb,
    private readonly muted: Rgb,
    private readonly primary: Rgb,
    private readonly accent: Rgb,
  ) {}

  all(): Piece[] {
    return this.pieces
  }

  private resolve(value: string): string {
    return resolveMergeFields(value ?? '', this.input.merge)
  }

  /**
   * The party making the offer, for the signature block (Phase 76).
   *
   * Taken from the merge context, which since Phase 76 is built from the
   * letterhead — so this is the same name and the same address the company's
   * invoices carry, rather than a third rendering of them.
   *
   * Empty when the context has no company at all, which is how a marketing
   * creative or a bare preview renders: the block then draws exactly as it did
   * before, rather than growing a heading with nothing under it.
   */
  private party(): string[] {
    const name = this.input.merge['company.name']
    if (!name) return []

    const address = (this.input.merge['company.address'] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    return [`Offered by ${name}`, ...address]
  }

  private paragraph(
    value: string,
    options: {
      font?: StandardFont
      size?: number
      color?: Rgb
      align?: 'left' | 'center' | 'right'
      leading?: number
      indent?: number
      spaceAfter?: number
    } = {},
  ): void {
    const font = options.font ?? this.body
    const size = options.size ?? this.input.brand.baseSizePt
    const leading = options.leading ?? size * 1.45
    const indent = options.indent ?? 0
    const width = this.contentWidth - indent

    const resolved = this.resolve(value)
    if (!resolved.trim()) return

    // Every wrapped line is its own piece, so a long paragraph splits across
    // pages instead of jumping to the next one whole and leaving a gap.
    const lines = wrapText(resolved, { font, size, maxWidth: width })

    lines.forEach((line, index) => {
      const lineWidth = widthOf(line, font, size)
      const x =
        options.align === 'center'
          ? MARGIN + indent + (width - lineWidth) / 2
          : options.align === 'right'
            ? MARGIN + indent + width - lineWidth
            : MARGIN + indent

      const isLast = index === lines.length - 1

      this.pieces.push({
        height: leading + (isLast ? (options.spaceAfter ?? size * 0.6) : 0),
        draw: (page, y) =>
          page.text(line, { x, y, font, size, color: options.color ?? this.text }),
      })
    })
  }

  private gap(height: number): void {
    this.pieces.push({ height, draw: () => undefined, spacer: true })
  }

  add(block: Block): void {
    const base = this.input.brand.baseSizePt

    switch (block.type) {
      case 'cover': {
        const title = this.resolve(block.title)
        const subtitle = this.resolve(block.subtitle)
        const preparedFor = this.resolve(block.preparedFor)

        const onBrand = block.useBrandBackground

        // Taller when a logo goes above the title, so the band does not crowd
        // it. Measured here rather than inside `draw`, because the piece's
        // height is what the page-breaking pass reads.
        const logoBand = block.showLogo && !onBrand && logoFor(this.input) ? 34 + base * 0.8 : 0
        const bandHeight = 132 + logoBand

        this.pieces.push({
          height: bandHeight,
          keepWithNext: true,
          draw: (page, y) => {
            if (onBrand) {
              // Bleeds to the very top of whatever page it lands on, not to
              // the top of the content area. A band with a white strip above
              // it — the height of the running header — reads as a mistake,
              // and the header is covered on a cover page anyway, which is
              // what a cover page wants.
              page.rect({
                x: 0,
                y: 0,
                width: page.widthPt,
                height: y + bandHeight,
                color: this.primary,
              })
            }

            const ink = onBrand ? { r: 1, g: 1, b: 1 } : this.text
            let cursor = y + 8

            /*
              The logo, since Phase 185.

              Height-bounded rather than width-bounded: logos are wide and
              short or square, and bounding the width makes a square mark
              enormous. 34 points is roughly a letterhead's, and the width
              follows the picture's own ratio so nothing is stretched.

              It is **not** drawn on the brand-coloured band. A logo is almost
              always one colour with a transparent surround, so a dark mark on
              a dark band is an invisible logo and a white mark on white is the
              same problem on the page below. Skipped rather than drawn wrong,
              and the band itself is the company's colour, which is what the
              toggle was reaching for.
            */
            const logo = logoFor(this.input)
            if (block.showLogo && logo && !onBrand) {
              const logoHeight = 34
              const logoWidth = (logoHeight * logo.widthPx) / logo.heightPx

              page.image({
                name: imageResourceName(this.input.logoAssetId!),
                x: MARGIN,
                y: cursor,
                width: logoWidth,
                height: logoHeight,
              })
              cursor += logoHeight + base * 0.8
            }

            if (title) {
              for (const line of wrapText(title, {
                font: this.headingBold,
                size: base * 2.2,
                maxWidth: this.contentWidth,
              })) {
                page.text(line, {
                  x: MARGIN,
                  y: cursor,
                  font: this.headingBold,
                  size: base * 2.2,
                  color: ink,
                })
                cursor += base * 2.6
              }
            }

            if (subtitle) {
              page.text(subtitle, {
                x: MARGIN,
                y: cursor + 4,
                font: this.body,
                size: base * 1.1,
                color: ink,
              })
              cursor += base * 1.8
            }

            if (preparedFor) {
              page.text(preparedFor, {
                x: MARGIN,
                y: cursor + 4,
                font: this.body,
                size: base,
                color: ink,
              })
            }
          },
        })

        this.gap(base * 1.5)
        return
      }

      case 'heading': {
        const size = block.level === 1 ? base * 1.8 : block.level === 2 ? base * 1.4 : base * 1.15
        const font = block.level === 3 ? this.headingBold : this.heading

        this.gap(base * 0.8)
        this.paragraph(block.text, {
          font,
          size,
          color: block.level === 1 ? this.primary : this.text,
          align: block.align,
          leading: size * 1.3,
          spaceAfter: base * 0.35,
        })

        // The last line of a heading holds onto whatever follows it, so a
        // section title cannot sit alone at the foot of a page.
        const last = this.pieces[this.pieces.length - 1]
        if (last) last.keepWithNext = true
        return
      }

      case 'text': {
        this.paragraph(block.text, {
          size: block.emphasis ? base * 1.15 : base,
          align: block.align,
          color: block.emphasis ? this.text : this.text,
        })
        return
      }

      case 'list': {
        block.items.forEach((item, index) => {
          const marker = block.ordered ? `${index + 1}.` : '-'
          const markerWidth = widthOf('00. ', this.body, base)

          const resolved = this.resolve(item)
          if (!resolved.trim()) return

          const lines = wrapText(resolved, {
            font: this.body,
            size: base,
            maxWidth: this.contentWidth - markerWidth,
          })

          lines.forEach((line, lineIndex) => {
            this.pieces.push({
              height: base * 1.45 + (lineIndex === lines.length - 1 ? base * 0.25 : 0),
              draw: (page, y) => {
                if (lineIndex === 0) {
                  page.text(marker, {
                    x: MARGIN,
                    y,
                    font: this.body,
                    size: base,
                    color: this.muted,
                  })
                }
                page.text(line, {
                  x: MARGIN + markerWidth,
                  y,
                  font: this.body,
                  size: base,
                  color: this.text,
                })
              },
            })
          })
        })

        this.gap(base * 0.5)
        return
      }

      case 'keyValue': {
        if (block.title) {
          this.paragraph(block.title, {
            font: this.headingBold,
            size: base * 1.15,
            spaceAfter: base * 0.3,
          })
          const last = this.pieces[this.pieces.length - 1]
          if (last) last.keepWithNext = true
        }

        const labelWidth = this.contentWidth * 0.35

        for (const row of block.rows) {
          const label = this.resolve(row.label)
          const value = this.resolve(row.value)

          this.pieces.push({
            height: base * 1.6,
            draw: (page, y) => {
              page.text(truncateToWidth(label, { font: this.body, size: base, maxWidth: labelWidth - 8 }), {
                x: MARGIN,
                y,
                font: this.body,
                size: base,
                color: this.muted,
              })
              page.text(
                truncateToWidth(value, {
                  font: this.body,
                  size: base,
                  maxWidth: this.contentWidth - labelWidth,
                }),
                { x: MARGIN + labelWidth, y, font: this.body, size: base, color: this.text },
              )
            },
          })
        }

        this.gap(base * 0.6)
        return
      }

      case 'table': {
        /*
          A plain table (Phase 181, §7). Each row is its own piece, so a long
          table breaks across pages where the engine already knows how to break
          — and the header is `keepWithNext` so a table never starts with its
          header orphaned at the foot of a page.

          Columns are equal width. Measuring content to size them is the right
          answer and a bigger one: it needs two passes over the rows and a rule
          for what to do when the widths do not fit, and equal columns are
          predictable rather than surprising. `MAX_TABLE_COLUMNS` is six for
          exactly this reason — six equal columns of this content width are
          still readable.
        */
        const { width, header, rows, align } = normalizeTable(block)
        if (width === 0) return

        if (block.title) {
          this.paragraph(block.title, {
            font: this.headingBold,
            size: base * 1.15,
            spaceAfter: base * 0.3,
          })
          const last = this.pieces[this.pieces.length - 1]
          if (last) last.keepWithNext = true
        }

        const columnWidth = this.contentWidth / width
        const PAD = 4

        /** Where a cell's text starts, given its alignment. */
        const cellX = (text: string, index: number, font: StandardFont, size: number) => {
          const left = MARGIN + index * columnWidth
          if (align[index] === 'left') return left + PAD
          // `widthOf` and not a font method: the fonts here are the standard
          // PDF fourteen, named by string, and their metrics live in
          // `pdf/metrics.ts`. The first draft called `widthOfTextAtSize` and
          // the typecheck refused it.
          const textWidth = widthOf(text, font, size)
          if (align[index] === 'right') return left + columnWidth - PAD - textWidth
          return left + (columnWidth - textWidth) / 2
        }

        const row = (
          cells: string[],
          options: { font: StandardFont; heading: boolean; first: boolean },
        ) => {
          const resolved = cells.map((cell) =>
            truncateToWidth(this.resolve(cell), {
              font: options.font,
              size: base,
              maxWidth: columnWidth - PAD * 2,
            }),
          )

          this.pieces.push({
            height: base * 1.7,
            keepWithNext: options.heading,
            draw: (page, y) => {
              resolved.forEach((text, index) => {
                page.text(text, {
                  x: cellX(text, index, options.font, base),
                  y: y + base * 0.35,
                  font: options.font,
                  size: base,
                  color: options.heading ? this.text : this.text,
                })
              })

              // A rule under the header, and between rows for `rows`/`grid`.
              // Nothing after the last row, which is what makes a bordered
              // table look drawn rather than boxed.
              if (block.style !== 'plain' && (options.heading || !options.first)) {
                page.rect({
                  x: MARGIN,
                  y: options.heading ? y : y + base * 1.7,
                  width: this.contentWidth,
                  height: options.heading ? 1 : 0.5,
                  color: this.muted,
                })
              }

              if (block.style === 'grid') {
                for (let index = 1; index < width; index += 1) {
                  page.rect({
                    x: MARGIN + index * columnWidth,
                    y,
                    width: 0.5,
                    height: base * 1.7,
                    color: this.muted,
                  })
                }
              }
            },
          })
        }

        if (header.length > 0) {
          row(header, { font: this.headingBold, heading: true, first: true })
        }
        rows.forEach((cells, index) => {
          row(cells, { font: this.body, heading: false, first: index === 0 && header.length === 0 })
        })

        this.gap(base * 0.6)
        return
      }

      case 'team': {
        /*
          The firm's people (Phase 183, §15). One piece per person, so a long
          team breaks across pages where the engine already knows how — and the
          title is `keepWithNext` so "Who you will be working with" never sits
          alone at the foot of a page.

          **Headshots are drawn, since Phase 185.** Phase 183 said they were
          not, and gave a reason — *"embedding an image means decoding it"* —
          which was true of this writer then and is the gap this phase closed.
          The rest of that sentence, that a photograph at whatever resolution is
          worse than a name set properly, turned out to be about placement
          rather than about embedding: a headshot bounded to a square and set
          beside the name prints like a capability statement, and nothing is
          resampled because a PDF image carries its own pixels at whatever size
          it is placed.

          `showPhotos` is now honoured on all three surfaces that can show one.
          The email still cannot, and says why where it degrades.
        */
        const members = selectTeam(this.input.team ?? [], block.memberIds)
        if (members.length === 0) return

        if (block.title) {
          this.paragraph(block.title, {
            font: this.headingBold,
            size: base * 1.15,
            spaceAfter: base * 0.3,
          })
          const last = this.pieces[this.pieces.length - 1]
          if (last) last.keepWithNext = true
        }

        for (const member of members) {
          const heading = block.showQualifications && member.qualifications
            ? `${member.name}, ${member.qualifications}`
            : member.name

          const headshot =
            block.showPhotos && member.headshotAssetId
              ? this.input.images?.get(member.headshotAssetId)
              : undefined

          /*
            One piece for the person when there is a photograph, rather than one
            per paragraph.

            The photograph has to sit beside the name *and* the role *and* the
            first of the bio, so the group cannot be split across a page — and
            `keepWithNext` chains three pieces together without guaranteeing
            they land on one page. A single piece whose height is the taller of
            the two columns does guarantee it, which is what a headshot needs
            and what text alone does not.
          */
          if (headshot?.ok) {
            const photo = SQUARE_HEADSHOT
            const gutter = base * 0.9
            const textX = MARGIN + photo + gutter
            const textWidth = this.contentWidth - photo - gutter

            const lines: Array<{ text: string; font: StandardFont; size: number; color: Rgb }> = []
            for (const line of wrapText(heading, {
              font: this.headingBold,
              size: base,
              maxWidth: textWidth,
            })) {
              lines.push({ text: line, font: this.headingBold, size: base, color: this.text })
            }
            if (member.title) {
              for (const line of wrapText(member.title, {
                font: this.body,
                size: base * 0.9,
                maxWidth: textWidth,
              })) {
                lines.push({ text: line, font: this.body, size: base * 0.9, color: this.muted })
              }
            }
            if (member.bio) {
              for (const paragraph of member.bio.split(/\n{2,}/)) {
                if (!paragraph.trim()) continue
                for (const line of wrapText(paragraph.trim(), {
                  font: this.body,
                  size: base,
                  maxWidth: textWidth,
                })) {
                  lines.push({ text: line, font: this.body, size: base, color: this.text })
                }
              }
            }

            const textHeight = lines.reduce((sum, line) => sum + line.size * 1.35, 0)

            this.pieces.push({
              height: Math.max(photo, textHeight) + base * 0.6,
              draw: (page, y) => {
                /*
                  Bounded to a square and **clipped**, not squashed. The picture
                  is scaled so its shorter side fills the square, centred on the
                  longer one, and the clipping path hides the overflow — which
                  is `object-fit: cover` done with PDF operators, and the same
                  answer the page's CSS gives, so the two agree.
                */
                const scale = photo / Math.min(headshot.image.widthPx, headshot.image.heightPx)
                const drawnWidth = headshot.image.widthPx * scale
                const drawnHeight = headshot.image.heightPx * scale

                page.image({
                  name: imageResourceName(member.headshotAssetId!),
                  x: MARGIN - (drawnWidth - photo) / 2,
                  y: y - (drawnHeight - photo) / 2,
                  width: drawnWidth,
                  height: drawnHeight,
                  clip: {
                    x: MARGIN,
                    y,
                    width: photo,
                    height: photo,
                    // Phase 186: the outline the author chose, drawn with the
                    // same path the `image` block's mask uses.
                    shape: block.photoShape === 'square' ? 'rect' : block.photoShape,
                  },
                })

                let cursor = y
                for (const line of lines) {
                  page.text(line.text, {
                    x: textX,
                    y: cursor,
                    font: line.font,
                    size: line.size,
                    color: line.color,
                  })
                  cursor += line.size * 1.35
                }
              },
            })
            continue
          }

          this.paragraph(heading, {
            font: this.headingBold,
            size: base,
            spaceAfter: 0,
          })
          const nameePiece = this.pieces[this.pieces.length - 1]
          if (nameePiece) nameePiece.keepWithNext = true

          if (member.title) {
            this.paragraph(member.title, {
              font: this.body,
              size: base * 0.9,
              color: this.muted,
              spaceAfter: base * 0.2,
            })
            const titlePiece = this.pieces[this.pieces.length - 1]
            if (titlePiece) titlePiece.keepWithNext = Boolean(member.bio)
          }

          if (member.bio) {
            this.paragraph(member.bio, { font: this.body, size: base, spaceAfter: base * 0.5 })
          }
        }

        this.gap(base * 0.4)
        return
      }

      case 'pricingTable': {
        this.pricingTable(block.title, {
          showQuantity: block.showQuantity,
          showUnitPrice: block.showUnitPrice,
          showTotals: block.showTotals,
        })
        return
      }

      case 'image': {
        /*
          The picture itself, since Phase 185.

          This used to be a frame reading *"Image — see the online version"*,
          and `writer.ts` declared it: *"no images beyond a placeholder frame."*
          Declared rather than hidden, which is why it survived — but the PDF is
          what a client downloads, prints, signs and files, so the company logo
          and the product photograph reached the web page and reached paper as a
          labelled empty box.

          Nothing is decoded here. `prepareImage` has already turned the upload
          into an XObject's worth of bytes; the piece's height comes from the
          picture's own aspect ratio so a photograph is not stretched, and the
          width is the author's `widthPercent` of the content width.
        */
        const prepared = block.assetId ? this.input.images?.get(block.assetId) : undefined
        const caption = this.resolve(block.caption)

        if (prepared?.ok) {
          /*
            The crop and the mask (Phase 186, §7's `crop/mask`).

            The box takes the **cropped** shape and the picture is drawn larger
            than it, offset so the chosen part lands inside, and clipped. The
            picture is never altered: `1 / crop.width` is a scale and nothing is
            resampled, which is the whole reason a crop is free here.

            An uncropped, unmasked image takes neither path, so the common case
            emits exactly what Phase 185 emitted.
          */
          const crop = normalizeCrop(block.crop)
          const width = (this.contentWidth * block.widthPercent) / 100
          const sourceRatio = prepared.image.heightPx / prepared.image.widthPx
          const height = (width * crop.height * sourceRatio) / crop.width

          const x =
            block.align === 'center'
              ? MARGIN + (this.contentWidth - width) / 2
              : block.align === 'right'
                ? MARGIN + this.contentWidth - width
                : MARGIN

          const drawnWidth = width / crop.width
          const drawnHeight = drawnWidth * sourceRatio
          const shape = block.maskShape === 'none' ? 'rect' : block.maskShape
          const clipped = !isWholeImage(crop) || block.maskShape !== 'none'

          this.pieces.push({
            height: height + (caption ? base * 1.6 : 0) + base * 0.6,
            draw: (page, y) => {
              page.image({
                name: imageResourceName(block.assetId!),
                x: clipped ? x - crop.x * drawnWidth : x,
                y: clipped ? y - crop.y * drawnHeight : y,
                width: clipped ? drawnWidth : width,
                height: clipped ? drawnHeight : height,
                clip: clipped ? { x, y, width, height, shape } : undefined,
              })
              if (caption) {
                page.text(caption, {
                  x,
                  y: y + height + base * 0.4,
                  font: this.body,
                  size: base * 0.85,
                  color: this.muted,
                })
              }
            },
          })
          return
        }

        /*
          No picture, and the frame now says **which** and **what to do**.

          Three different situations, deliberately worded differently. An
          author who placed no asset sees that; an author whose PNG is
          interlaced sees that, and the remedy; and a reader of a document whose
          asset has gone sees a third thing. The old single sentence told a
          client holding a printed page to go and look at something else, which
          is not a remedy and not addressed to them.
        */
        const height = 110
        const message = !block.assetId
          ? 'No image chosen for this block.'
          : prepared
            ? `Cannot print this image — ${prepared.refusal.reason}. ${prepared.refusal.remedy}`
            : 'This image is no longer in the asset library.'

        this.pieces.push({
          height: height + (caption ? base * 1.6 : 0) + base * 0.6,
          draw: (page, y) => {
            page.frame({
              x: MARGIN,
              y,
              width: this.contentWidth,
              height,
              color: this.muted,
            })
            for (const [line, at] of wrapText(message, {
              font: this.body,
              size: base * 0.9,
              maxWidth: this.contentWidth - 24,
            }).entries()) {
              page.text(at, {
                x: MARGIN + 12,
                y: y + height / 2 - base + line * base * 1.3,
                font: this.body,
                size: base * 0.9,
                color: this.muted,
              })
            }
            if (caption) {
              page.text(caption, {
                x: MARGIN,
                y: y + height + base * 0.4,
                font: this.body,
                size: base * 0.85,
                color: this.muted,
              })
            }
          },
        })
        return
      }

      case 'video': {
        /*
          A video stays a placeholder, and that is not the same gap.

          An image's absence from paper was a defect; a video's is the medium.
          There is no frame to print, so the box says where to watch it — which
          is a remedy, unlike the sentence it used to share with `image`.
        */
        const height = 110
        const caption = this.resolve(block.caption)

        this.pieces.push({
          height: height + (caption ? base * 1.6 : 0) + base * 0.6,
          draw: (page, y) => {
            page.frame({
              x: MARGIN,
              y,
              width: this.contentWidth,
              height,
              color: this.muted,
            })
            page.text(
              'Video — open this proposal online to watch it',
              {
                x: MARGIN + 12,
                y: y + height / 2 - base / 2,
                font: this.body,
                size: base * 0.9,
                color: this.muted,
              },
            )
            if (caption) {
              page.text(caption, {
                x: MARGIN,
                y: y + height + 6,
                font: this.body,
                size: base * 0.9,
                color: this.muted,
              })
            }
          },
        })
        return
      }

      case 'divider': {
        this.pieces.push({
          height: base * 1.6,
          draw: (page, y) =>
            page.rect({
              x: MARGIN,
              y: y + base * 0.7,
              width: this.contentWidth,
              height: 0.75,
              color: this.muted,
            }),
        })
        return
      }

      case 'spacer': {
        this.gap(block.heightPt)
        return
      }

      case 'columns': {
        const count = block.columns.length
        const gutter = 18
        const columnWidth = (this.contentWidth - gutter * (count - 1)) / count

        // Columns are measured together and placed together: the tallest one
        // sets the height, so two columns cannot drift apart across a break.
        const rendered = block.columns.map((column) => ({
          heading: this.resolve(column.heading),
          lines: wrapText(this.resolve(column.body), {
            font: this.body,
            size: base * 0.95,
            maxWidth: columnWidth,
          }),
        }))

        const tallest = Math.max(...rendered.map((column) => column.lines.length))
        const height = base * 1.6 + tallest * base * 1.35 + base * 0.8

        this.pieces.push({
          height,
          draw: (page, y) => {
            rendered.forEach((column, index) => {
              const x = MARGIN + index * (columnWidth + gutter)

              if (column.heading) {
                page.text(
                  truncateToWidth(column.heading, {
                    font: this.headingBold,
                    size: base,
                    maxWidth: columnWidth,
                  }),
                  { x, y, font: this.headingBold, size: base, color: this.text },
                )
              }

              column.lines.forEach((line, lineIndex) => {
                page.text(line, {
                  x,
                  y: y + base * 1.6 + lineIndex * base * 1.35,
                  font: this.body,
                  size: base * 0.95,
                  color: this.text,
                })
              })
            })
          },
        })
        return
      }

      case 'clause': {
        if (block.title) {
          this.paragraph(block.title, {
            font: this.headingBold,
            size: base * 1.05,
            spaceAfter: base * 0.25,
          })
          const last = this.pieces[this.pieces.length - 1]
          if (last) last.keepWithNext = true
        }
        this.paragraph(block.body, { size: base * 0.92, color: this.muted })
        return
      }

      case 'signature': {
        const height = 96
        const prompt = this.resolve(block.prompt)
        const agreement = this.resolve(block.agreementText)

        const agreementLines = wrapText(agreement, {
          font: this.body,
          size: base * 0.9,
          maxWidth: this.contentWidth - 24,
        })

        // Who is offering (Phase 76).
        //
        // This block is where a proposal stops being a document and becomes a
        // contract: the client signs here, and `proposal_acceptances` records
        // their name, their title, their typed signature, the version they were
        // looking at and the network they signed from. The agreement text names
        // them — "on behalf of {{client.name}}".
        //
        // The other party was never named. A signed agreement identified the
        // side that signed it and not the side that would be bound by it.
        //
        // Read from the merge context rather than from a new block field, so it
        // appears on proposals that were composed before this phase — the ones
        // whose authors cannot go back and add it.
        const offeredBy = this.party()

        const total =
          height + (agreementLines.length + offeredBy.length) * base * 1.3 + base * 2

        this.pieces.push({
          height: total,
          draw: (page, y) => {
            page.frame({
              x: MARGIN,
              y,
              width: this.contentWidth,
              height: total - base,
              color: this.accent,
              lineWidth: 1,
            })

            page.text(prompt, {
              x: MARGIN + 12,
              y: y + 12,
              font: this.headingBold,
              size: base * 1.1,
              color: this.text,
            })

            agreementLines.forEach((line, index) => {
              page.text(line, {
                x: MARGIN + 12,
                y: y + 12 + base * 1.9 + index * base * 1.3,
                font: this.body,
                size: base * 0.9,
                color: this.muted,
              })
            })

            offeredBy.forEach((line, index) => {
              page.text(line, {
                x: MARGIN + 12,
                y:
                  y +
                  12 +
                  base * 1.9 +
                  (agreementLines.length + index) * base * 1.3 +
                  base * 0.6,
                font: index === 0 ? this.headingBold : this.body,
                size: base * 0.9,
                color: this.muted,
              })
            })

            const ruleY = y + total - base * 2.4
            page.rect({
              x: MARGIN + 12,
              y: ruleY,
              width: this.contentWidth * 0.45,
              height: 0.75,
              color: this.muted,
            })
            page.text('Signature', {
              x: MARGIN + 12,
              y: ruleY + 5,
              font: this.body,
              size: base * 0.8,
              color: this.muted,
            })

            page.rect({
              x: MARGIN + this.contentWidth * 0.55,
              y: ruleY,
              width: this.contentWidth * 0.33,
              height: 0.75,
              color: this.muted,
            })
            page.text('Date', {
              x: MARGIN + this.contentWidth * 0.55,
              y: ruleY + 5,
              font: this.body,
              size: base * 0.8,
              color: this.muted,
            })
          },
        })
        return
      }

      case 'pageBreak': {
        // Height beyond any page forces the placer to start a new one, and the
        // piece draws nothing when it gets there.
        this.pieces.push({ height: Number.POSITIVE_INFINITY, draw: () => undefined })
        return
      }

      case 'button': {
        const label = this.resolve(block.label)
        const url = this.resolve(block.url)

        // A button is a link with a box round it. In print the URL has to be
        // readable or the call to action is a dead end, so it is written out.
        this.paragraph(label, {
          font: this.headingBold,
          size: base * 1.05,
          align: block.align,
          spaceAfter: 2,
        })
        if (url) {
          this.paragraph(url, {
            size: base * 0.85,
            align: block.align,
            color: this.accent,
          })
        }
        return
      }

      case 'qrCode': {
        const caption = this.resolve(block.caption)
        const size = block.sizePt

        this.pieces.push({
          height: size + (caption ? base * 1.6 : 0) + base * 0.6,
          draw: (page, y) => {
            const x =
              block.align === 'center'
                ? MARGIN + (this.contentWidth - size) / 2
                : block.align === 'right'
                  ? MARGIN + this.contentWidth - size
                  : MARGIN

            page.frame({ x, y, width: size, height: size, color: this.muted })
            page.text('QR', {
              x: x + size / 2 - 8,
              y: y + size / 2 - base / 2,
              font: this.body,
              size: base,
              color: this.muted,
            })

            if (caption) {
              page.text(caption, {
                x,
                y: y + size + 6,
                font: this.body,
                size: base * 0.9,
                color: this.muted,
              })
            }
          },
        })
        return
      }
    }
  }

  /**
   * The fee table.
   *
   * Header cells repeat on every page the table spans, because a column of
   * figures with no headings two pages later is a table nobody can read.
   */
  pricingTable(
    rawTitle: string,
    options: { showQuantity: boolean; showUnitPrice: boolean; showTotals: boolean },
  ): void {
    const base = this.input.brand.baseSizePt
    const lines = this.input.lines ?? []
    const title = this.resolve(rawTitle)

    if (title) {
      this.paragraph(title, {
        font: this.headingBold,
        size: base * 1.25,
        spaceAfter: base * 0.4,
      })
      const last = this.pieces[this.pieces.length - 1]
      if (last) last.keepWithNext = true
    }

    if (lines.length === 0) return

    const amountWidth = 80
    const unitWidth = options.showUnitPrice ? 80 : 0
    const quantityWidth = options.showQuantity ? 52 : 0
    const descriptionWidth = this.contentWidth - amountWidth - unitWidth - quantityWidth

    const columnX = {
      description: MARGIN,
      quantity: MARGIN + descriptionWidth,
      unit: MARGIN + descriptionWidth + quantityWidth,
      amount: MARGIN + descriptionWidth + quantityWidth + unitWidth,
    }

    const right = (page: PageCanvas, value: string, x: number, width: number, y: number, font: StandardFont, size: number, color: Rgb) => {
      page.text(value, {
        x: x + width - widthOf(value, font, size),
        y,
        font,
        size,
        color,
      })
    }

    const header: Piece = {
      height: base * 2,
      keepWithNext: true,
      draw: (page, y) => {
        page.text('Description', {
          x: columnX.description,
          y,
          font: this.headingBold,
          size: base * 0.85,
          color: this.muted,
        })
        if (options.showQuantity) {
          right(page, 'Qty', columnX.quantity, quantityWidth, y, this.headingBold, base * 0.85, this.muted)
        }
        if (options.showUnitPrice) {
          right(page, 'Unit', columnX.unit, unitWidth, y, this.headingBold, base * 0.85, this.muted)
        }
        right(page, 'Amount', columnX.amount, amountWidth, y, this.headingBold, base * 0.85, this.muted)

        page.rect({
          x: MARGIN,
          y: y + base * 1.35,
          width: this.contentWidth,
          height: 0.75,
          color: this.muted,
        })
      },
    }

    this.pieces.push(header)

    for (const line of lines) {
      // An unselected optional item is priced at nothing, and says so, rather
      // than being hidden — the client chose not to take it and the document
      // should show that they were offered it.
      const excluded = line.isOptional && !line.isSelected
      const descriptionLines = wrapText(line.description, {
        font: this.body,
        size: base * 0.95,
        maxWidth: descriptionWidth - 10,
      })

      const height = Math.max(descriptionLines.length, 1) * base * 1.35 + base * 0.5

      this.pieces.push({
        height,
        draw: (page, y) => {
          descriptionLines.forEach((text, index) => {
            page.text(text, {
              x: columnX.description,
              y: y + index * base * 1.35,
              font: this.body,
              size: base * 0.95,
              color: excluded ? this.muted : this.text,
            })
          })

          if (line.isOptional) {
            page.text(excluded ? '(optional — not selected)' : '(optional — selected)', {
              x: columnX.description,
              y: y + descriptionLines.length * base * 1.35,
              font: this.body,
              size: base * 0.78,
              color: this.muted,
            })
          }

          const ink = excluded ? this.muted : this.text

          if (options.showQuantity) {
            right(page, quantity(line.quantityMilli), columnX.quantity, quantityWidth, y, this.body, base * 0.95, ink)
          }
          if (options.showUnitPrice) {
            right(page, money(line.unitPriceCents), columnX.unit, unitWidth, y, this.body, base * 0.95, ink)
          }
          right(
            page,
            excluded ? '--' : money(line.amountCents),
            columnX.amount,
            amountWidth,
            y,
            this.body,
            base * 0.95,
            ink,
          )
        },
      })

      if (line.isOptional) this.gap(base * 0.9)
    }

    const totals = this.input.totals
    if (!options.showTotals || !totals) return

    const rows: Array<[string, number, boolean]> = [
      ['Subtotal', totals.subtotalCents, false],
      ...(totals.discountCents ? ([['Discount', -totals.discountCents, false]] as Array<[string, number, boolean]>) : []),
      ...(totals.taxCents ? ([['Tax', totals.taxCents, false]] as Array<[string, number, boolean]>) : []),
      ['Total', totals.totalCents, true],
    ]

    this.pieces.push({
      height: base * 0.9,
      keepWithNext: true,
      draw: (page, y) =>
        page.rect({
          x: MARGIN + this.contentWidth * 0.5,
          y: y + base * 0.4,
          width: this.contentWidth * 0.5,
          height: 0.75,
          color: this.muted,
        }),
    })

    rows.forEach(([label, cents, strong]) => {
      const font = strong ? this.headingBold : this.body
      const size = strong ? base * 1.1 : base * 0.95

      this.pieces.push({
        height: size * 1.5,
        draw: (page, y) => {
          const value = money(cents)
          page.text(label, {
            x: columnX.unit - 40,
            y,
            font,
            size,
            color: strong ? this.text : this.muted,
          })
          page.text(value, {
            x: columnX.amount + amountWidth - widthOf(value, font, size),
            y,
            font,
            size,
            color: strong ? this.primary : this.text,
          })
        },
      })
    })

    this.gap(base)
  }
}

/**
 * Renders a document to PDF bytes.
 *
 * Deterministic: the same input produces the same file, byte for byte. Nothing
 * here reads a clock, and the only date that reaches the file is
 * `input.createdAt`.
 */
/**
 * The PDF resource name an asset is placed under (Phase 185).
 *
 * A uuid is not a valid PDF name — `/` names cannot hold hyphens safely across
 * readers — so the hyphens go and an `Im` prefix is added, which keeps the id
 * recoverable by eye when reading the file in a text editor. Derived rather
 * than counted, so the layout pass and the resource dictionary cannot disagree
 * about which picture is `/Im1`.
 */
/** The prepared logo, when there is one and it embedded. */
function logoFor(input: RenderInput): EmbeddableImage | null {
  if (!input.logoAssetId) return null
  const prepared = input.images?.get(input.logoAssetId)
  return prepared?.ok ? prepared.image : null
}

export function imageResourceName(assetId: string): string {
  return `Im${assetId.replace(/-/g, '')}`
}

export function renderDocumentPdf(input: RenderInput): Buffer {
  const size = PAGE_SIZES[input.pageSize] ?? PAGE_SIZES.letter
  const landscape = input.orientation === 'landscape'
  const pageWidth = landscape ? size.height : size.width
  const pageHeight = landscape ? size.width : size.height

  const contentWidth = pageWidth - MARGIN * 2
  const body = familyFor(input.brand.bodyFont)
  const heading = familyFor(input.brand.headingFont, true)
  const headingBold = familyFor(input.brand.bodyFont, true)

  /*
    The fallback is the default kit put through the same conversion, not a
    float triple typed alongside it (Phase 79).

    These three were `{ r: 0.06, g: 0.09, b: 0.16 }` and two like it —
    somebody's hand conversion of the same hex the rest of the application
    uses, and all three were a digit out. `#0f172a` is `0.0588 0.0902 0.1647`.

    Reached whenever a stored brand colour will not parse, which until Phase 79
    included any three-digit one, since `isHexColor` accepts `#fff` and this
    did not. `parseColor` does the conversion correctly and always did.
  */
  const text = parseColor(input.brand.textColor, parseColor(DEFAULT_BRAND_KIT.textColor))
  const muted = parseColor(input.brand.mutedColor, parseColor(DEFAULT_BRAND_KIT.mutedColor))
  const primary = parseColor(input.brand.primaryColor, parseColor(DEFAULT_BRAND_KIT.primaryColor))
  const accent = parseColor(input.brand.accentColor, primary)

  const composer = new Composer(
    input,
    contentWidth,
    body,
    heading,
    headingBold,
    text,
    muted,
    primary,
    accent,
  )

  for (const block of input.blocks) composer.add(block)

  const hasHeader = Boolean(input.headerText?.trim())
  const hasFooter =
    Boolean(input.footerText?.trim()) ||
    Boolean(input.disclosureText?.trim()) ||
    input.showPageNumbers

  const contentTop = MARGIN + (hasHeader ? HEADER_BAND : 0)
  const contentBottom = pageHeight - MARGIN - (hasFooter ? FOOTER_BAND : 0)
  const usable = contentBottom - contentTop

  // --- Place the pieces -----------------------------------------------------

  const pages: Array<Array<{ piece: Piece; y: number }>> = [[]]
  let cursor = 0

  const pieces = composer.all()

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]

    if (!Number.isFinite(piece.height)) {
      // A page break. Only starts a new page if anything is on this one, so
      // two breaks in a row do not produce a blank sheet.
      if (pages[pages.length - 1].length > 0) {
        pages.push([])
        cursor = 0
      }
      continue
    }

    // A piece that keeps with the next one needs room for both, or the pair
    // moves together.
    let required = piece.height
    if (piece.keepWithNext) {
      const next = pieces[index + 1]
      if (next && Number.isFinite(next.height)) required += next.height
    }

    if (cursor > 0 && cursor + required > usable) {
      pages.push([])
      cursor = 0
    }

    // Space between blocks is meaningless at the top of a page — it reads as
    // a document that starts an inch too low, which is the commonest way
    // paginated output looks amateur.
    if (piece.spacer && cursor === 0) continue

    pages[pages.length - 1].push({ piece, y: cursor })
    cursor += piece.height
  }

  // --- Draw -----------------------------------------------------------------

  const canvases = pages
    // A trailing empty page happens when the last block was a page break.
    .filter((page, index) => page.length > 0 || index === 0)
    .map((placed, pageIndex, all) => {
      const canvas = new PageCanvas(pageWidth, pageHeight)

      if (hasHeader) {
        const headerText = resolveMergeFields(input.headerText ?? '', input.merge)
        canvas.text(
          truncateToWidth(headerText, { font: body, size: 9, maxWidth: contentWidth }),
          { x: MARGIN, y: MARGIN - 6, font: body, size: 9, color: muted },
        )
        canvas.rect({
          x: MARGIN,
          y: MARGIN + 10,
          width: contentWidth,
          height: 0.5,
          color: muted,
        })
      }

      for (const { piece, y } of placed) piece.draw(canvas, contentTop + y)

      if (hasFooter) {
        const footerY = pageHeight - MARGIN - 12

        if (input.footerText?.trim()) {
          const footerText = resolveMergeFields(input.footerText, input.merge)
          canvas.text(
            truncateToWidth(footerText, { font: body, size: 9, maxWidth: contentWidth - 60 }),
            { x: MARGIN, y: footerY, font: body, size: 9, color: muted },
          )
        }

        if (input.disclosureText?.trim()) {
          // Above the footer line, so it is neither mixed into the author's
          // words nor competing with the page number.
          canvas.text(
            truncateToWidth(input.disclosureText.trim(), {
              font: body,
              size: 8,
              maxWidth: contentWidth,
            }),
            { x: MARGIN, y: footerY - 11, font: body, size: 8, color: muted },
          )
        }

        if (input.showPageNumbers) {
          const label = `${pageIndex + 1} of ${all.length}`
          canvas.text(label, {
            x: MARGIN + contentWidth - widthOf(label, body, 9),
            y: footerY,
            font: body,
            size: 9,
            color: muted,
          })
        }
      }

      return canvas
    })

  /*
    Only the pictures a page actually invoked.

    Asked of the canvases rather than worked out from the blocks, and the
    difference is not pedantry: a block can decline to draw its picture — a
    logo on a brand-coloured band does — and a map keyed off the blocks would
    put an XObject in the file that nothing references. Weight in the file, and
    a reader wondering why it is there.

    The first version of this embedded every *prepared* image and carried a
    comment saying it embedded only the placed ones. The test caught the
    comment, which is the only reason this paragraph is accurate.
  */
  const invoked = new Set<string>()
  for (const canvas of canvases) {
    for (const name of canvas.usedImages()) invoked.add(name)
  }

  const embedded = new Map<string, EmbeddableImage>()
  for (const [assetId, result] of input.images ?? []) {
    const name = imageResourceName(assetId)
    if (result.ok && invoked.has(name)) embedded.set(name, result.image)
  }

  return writePdf({
    pages: canvases,
    title: input.title,
    author: input.author,
    createdAt: input.createdAt,
    images: embedded,
  })
}
