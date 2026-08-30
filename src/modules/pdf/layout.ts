import type { Block } from '@/modules/design/blocks'
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
  showPageNumbers: boolean
  /** Supplied by the caller so the figures cannot drift from the record. */
  lines?: PricingLine[]
  totals?: DocumentTotals
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

        const bandHeight = 132
        const onBrand = block.useBrandBackground

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

      case 'pricingTable': {
        this.pricingTable(block.title, {
          showQuantity: block.showQuantity,
          showUnitPrice: block.showUnitPrice,
          showTotals: block.showTotals,
        })
        return
      }

      case 'image':
      case 'video': {
        // An image is a frame with its filename, not the picture.
        //
        // Embedding raster data means decoding JPEG and PNG and writing image
        // XObjects, which is a phase of its own. A labelled placeholder is
        // visibly incomplete, which is the right kind of wrong: a silently
        // missing logo would be discovered by a client.
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
              block.type === 'video' ? 'Video — see the online version' : 'Image — see the online version',
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
export function renderDocumentPdf(input: RenderInput): Buffer {
  const size = PAGE_SIZES[input.pageSize] ?? PAGE_SIZES.letter
  const landscape = input.orientation === 'landscape'
  const pageWidth = landscape ? size.height : size.width
  const pageHeight = landscape ? size.width : size.height

  const contentWidth = pageWidth - MARGIN * 2
  const body = familyFor(input.brand.bodyFont)
  const heading = familyFor(input.brand.headingFont, true)
  const headingBold = familyFor(input.brand.bodyFont, true)

  const text = parseColor(input.brand.textColor, { r: 0.06, g: 0.09, b: 0.16 })
  const muted = parseColor(input.brand.mutedColor, { r: 0.39, g: 0.45, b: 0.55 })
  const primary = parseColor(input.brand.primaryColor, { r: 0.05, g: 0.43, b: 0.38 })
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
  const hasFooter = Boolean(input.footerText?.trim()) || input.showPageNumbers

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

  return writePdf({
    pages: canvases,
    title: input.title,
    author: input.author,
    createdAt: input.createdAt,
  })
}
