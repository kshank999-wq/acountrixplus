import { formatCents } from '@/lib/money'
import type { Block } from '@/modules/design/blocks'

/**
 * The block renderer (spec §7).
 *
 * One server component per block type. Shared by the authenticated preview and
 * the public client-facing page, so what an author sees and what a client
 * receives cannot drift apart.
 *
 * Brand values arrive as CSS custom properties on the page wrapper rather than
 * being baked into each block, which is what lets one document render under a
 * different brand kit without touching its content.
 */

export type BrandTokens = {
  primaryColor: string
  accentColor: string
  textColor: string
  mutedColor: string
  surfaceColor: string
  headingFont: string
  bodyFont: string
  baseSizePt: number
}

export const DEFAULT_BRAND: BrandTokens = {
  primaryColor: '#0d6e60',
  accentColor: '#0f766e',
  textColor: '#0f172a',
  mutedColor: '#64748b',
  surfaceColor: '#ffffff',
  headingFont: 'Georgia, serif',
  bodyFont: 'system-ui, sans-serif',
  baseSizePt: 11,
}

export type RenderItem = {
  id: string
  description: string
  quantityMilli: number
  unitPriceCents: number
  amountCents: number
  isOptional: boolean
  isSelected: boolean
}

export type RenderData = {
  items: RenderItem[]
  discountCents: number
  taxCents: number
  logoUrl: string | null
  /**
   * Builds the URL for an image block's asset. The public page appends its
   * proposal token, since an anonymous viewer has no session to authorize the
   * read with.
   */
  assetUrl: (assetId: string) => string
  /** Rendered by the public page, which supplies its own interactive form. */
  signatureSlot?: React.ReactNode
  /** Optional-item checkboxes are interactive only on the client-facing page. */
  pricingSlot?: React.ReactNode
}

/** Page dimensions in points, for print sizing. */
const PAGE_WIDTH_PT: Record<string, number> = { letter: 612, a4: 595, legal: 612 }

export function documentStyle(brand: BrandTokens): React.CSSProperties {
  return {
    // Consumed by the CSS in `document-print.css`.
    ['--doc-primary' as string]: brand.primaryColor,
    ['--doc-accent' as string]: brand.accentColor,
    ['--doc-text' as string]: brand.textColor,
    ['--doc-muted' as string]: brand.mutedColor,
    ['--doc-surface' as string]: brand.surfaceColor,
    ['--doc-heading-font' as string]: brand.headingFont,
    ['--doc-body-font' as string]: brand.bodyFont,
    ['--doc-base-size' as string]: `${brand.baseSizePt}pt`,
  }
}

export function contentWidthPt(pageSize: string, marginLeft: number, marginRight: number) {
  return (PAGE_WIDTH_PT[pageSize] ?? 612) - marginLeft - marginRight
}

/** Splits authored text into paragraphs on blank lines. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

export function BlockView({ block, data }: { block: Block; data: RenderData }) {
  switch (block.type) {
    case 'cover':
      return <CoverBlock block={block} logoUrl={data.logoUrl} />
    case 'heading':
      return <HeadingBlock block={block} />
    case 'text':
      return <TextBlock block={block} />
    case 'list':
      return <ListBlock block={block} />
    case 'keyValue':
      return <KeyValueBlock block={block} />
    case 'pricingTable':
      return <PricingBlock block={block} data={data} />
    case 'image':
      return <ImageBlock block={block} assetUrl={data.assetUrl} />
    case 'columns':
      return <ColumnsBlock block={block} />
    case 'clause':
      return <ClauseBlock block={block} />
    case 'signature':
      return <SignatureBlock block={block} slot={data.signatureSlot} />
    case 'divider':
      return <hr className="doc-divider" />
    case 'spacer':
      return <div style={{ height: `${block.heightPt}pt` }} aria-hidden="true" />
    case 'pageBreak':
      return <div className="doc-page-break" aria-hidden="true" />
    default:
      return null
  }
}

function CoverBlock({
  block,
  logoUrl,
}: {
  block: Extract<Block, { type: 'cover' }>
  logoUrl: string | null
}) {
  return (
    <section className={`doc-cover ${block.useBrandBackground ? 'doc-cover-brand' : ''}`}>
      {block.showLogo && logoUrl && (
        // A plain img: the renderer must work identically in print and in the
        // client's email preview, where Next's image optimizer is unavailable.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="doc-cover-logo" />
      )}
      {block.title && <h1 className="doc-cover-title">{block.title}</h1>}
      {block.subtitle && <p className="doc-cover-subtitle">{block.subtitle}</p>}
      {block.preparedFor && <p className="doc-cover-for">{block.preparedFor}</p>}
    </section>
  )
}

function HeadingBlock({ block }: { block: Extract<Block, { type: 'heading' }> }) {
  const Tag = (`h${block.level}` as const) satisfies 'h1' | 'h2' | 'h3'
  return (
    <Tag className={`doc-heading doc-heading-${block.level}`} style={{ textAlign: block.align }}>
      {block.text}
    </Tag>
  )
}

function TextBlock({ block }: { block: Extract<Block, { type: 'text' }> }) {
  const parts = paragraphs(block.text)
  if (parts.length === 0) return null

  return (
    <div className={`doc-text ${block.emphasis ? 'doc-text-lead' : ''}`}>
      {parts.map((paragraph, index) => (
        <p key={index} style={{ textAlign: block.align }}>
          {paragraph}
        </p>
      ))}
    </div>
  )
}

function ListBlock({ block }: { block: Extract<Block, { type: 'list' }> }) {
  const items = block.items.filter((item) => item.trim())
  if (items.length === 0) return null

  const Tag = block.ordered ? 'ol' : 'ul'
  return (
    <Tag className="doc-list">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </Tag>
  )
}

function KeyValueBlock({ block }: { block: Extract<Block, { type: 'keyValue' }> }) {
  // Rows arrive with merge fields already resolved, so an empty value means
  // the underlying data is missing. A labelled blank line on a client-facing
  // document reads as unfinished, so the row is dropped instead.
  const rows = block.rows.filter((row) => row.value.trim())
  if (rows.length === 0) return null

  return (
    <section className="doc-kv">
      {block.title && <h3 className="doc-heading doc-heading-3">{block.title}</h3>}
      <table>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * The fee table (spec §7).
 *
 * Renders whatever items the caller supplies, so the figures can never drift
 * from the proposal's real totals. Unselected optional items are shown as
 * available extras rather than hidden, since a client should be able to see
 * what they are declining.
 */
function PricingBlock({
  block,
  data,
}: {
  block: Extract<Block, { type: 'pricingTable' }>
  data: RenderData
}) {
  const included = data.items.filter((item) => !item.isOptional || item.isSelected)
  const optional = data.items.filter((item) => item.isOptional && !item.isSelected)

  const subtotal = included.reduce((sum, item) => sum + item.amountCents, 0)
  const total = subtotal - data.discountCents + data.taxCents

  return (
    <section className="doc-pricing">
      {block.title && <h3 className="doc-heading doc-heading-3">{block.title}</h3>}

      <table className="doc-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            {block.showQuantity && <th scope="col" className="doc-num">Qty</th>}
            {block.showUnitPrice && <th scope="col" className="doc-num">Rate</th>}
            <th scope="col" className="doc-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {included.map((item) => (
            <tr key={item.id}>
              <td>{item.description}</td>
              {block.showQuantity && (
                <td className="doc-num">{formatQuantity(item.quantityMilli)}</td>
              )}
              {block.showUnitPrice && (
                <td className="doc-num">{formatCents(item.unitPriceCents)}</td>
              )}
              <td className="doc-num">{formatCents(item.amountCents)}</td>
            </tr>
          ))}
        </tbody>

        {block.showTotals && (
          <tfoot>
            {data.discountCents > 0 && (
              <tr>
                <td colSpan={columnCount(block)}>Discount</td>
                <td className="doc-num">−{formatCents(data.discountCents)}</td>
              </tr>
            )}
            {data.taxCents > 0 && (
              <tr>
                <td colSpan={columnCount(block)}>Tax</td>
                <td className="doc-num">{formatCents(data.taxCents)}</td>
              </tr>
            )}
            <tr className="doc-total">
              <td colSpan={columnCount(block)}>Total</td>
              <td className="doc-num">{formatCents(total)}</td>
            </tr>
          </tfoot>
        )}
      </table>

      {/* The client-facing page passes interactive checkboxes here. */}
      {data.pricingSlot}

      {!data.pricingSlot && optional.length > 0 && (
        <div className="doc-optional">
          <h4>Optional additions</h4>
          <table className="doc-table">
            <tbody>
              {optional.map((item) => (
                <tr key={item.id}>
                  <td>{item.description}</td>
                  <td className="doc-num">{formatCents(item.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function columnCount(block: Extract<Block, { type: 'pricingTable' }>): number {
  return 1 + (block.showQuantity ? 1 : 0) + (block.showUnitPrice ? 1 : 0)
}

/** Thousandths to a readable quantity: 1500 → "1.5", 2000 → "2". */
export function formatQuantity(quantityMilli: number): string {
  const value = quantityMilli / 1000
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '')
}

function ImageBlock({
  block,
  assetUrl,
}: {
  block: Extract<Block, { type: 'image' }>
  assetUrl: (assetId: string) => string
}) {
  if (!block.assetId) return null

  return (
    <figure className="doc-figure" style={{ textAlign: block.align }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={assetUrl(block.assetId)}
        alt={block.caption || ''}
        style={{ width: `${block.widthPercent}%` }}
      />
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  )
}

function ColumnsBlock({ block }: { block: Extract<Block, { type: 'columns' }> }) {
  return (
    <div className="doc-columns" data-count={block.columns.length}>
      {block.columns.map((column, index) => (
        <div key={index}>
          {column.heading && <h4>{column.heading}</h4>}
          {paragraphs(column.body).map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex}>{paragraph}</p>
          ))}
        </div>
      ))}
    </div>
  )
}

function ClauseBlock({ block }: { block: Extract<Block, { type: 'clause' }> }) {
  if (!block.body) return null

  return (
    <section className="doc-clause">
      {block.title && <h4>{block.title}</h4>}
      {paragraphs(block.body).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </section>
  )
}

function SignatureBlock({
  block,
  slot,
}: {
  block: Extract<Block, { type: 'signature' }>
  slot?: React.ReactNode
}) {
  return (
    <section className="doc-signature">
      <h3 className="doc-heading doc-heading-3">{block.prompt}</h3>
      <p className="doc-agreement">{block.agreementText}</p>

      {slot ?? (
        // Print fallback: ruled lines for a wet signature.
        <div className="doc-signature-lines">
          <div>
            <span />
            <label>Signature</label>
          </div>
          <div>
            <span />
            <label>Name and title</label>
          </div>
          <div>
            <span />
            <label>Date</label>
          </div>
        </div>
      )}
    </section>
  )
}
