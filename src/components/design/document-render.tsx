import { formatCents } from '@/lib/money'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import {
  ROUNDED_MASK_FRACTION,
  isWholeImage,
  normalizeCrop,
  normalizeTable,
  type Block,
} from '@/modules/design/blocks'
import { shapeSvg } from '@/modules/design/shapes'
import { selectTeam, type RenderedTeamMember } from '@/modules/studio/team-render'
import { safeUrl } from '@/modules/design/urls'

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

/**
 * The kit a company that has never opened the Design Center gets.
 *
 * One constant, in `modules/design/brand`, since Phase 79 — it was written out
 * here, in `pdf/service`, in `pdf/invoice`, in the Design Center's form, in the
 * column defaults, and a sixth time in `pdf/layout` as hand-converted floats
 * that had drifted a digit. Re-exported under the name callers already use.
 */
export const DEFAULT_BRAND: BrandTokens = DEFAULT_BRAND_KIT

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
  /**
   * The resolved brand colours (Phase 193).
   *
   * Supplied by `DocumentPage`, which already holds them. A `shape` block
   * needs an actual colour rather than `var(--doc-primary)`, because the PDF
   * resolves one and the two have to be the same answer — a custom property
   * on one surface and a lookup on the other is two answers to "what colour
   * is primary", differing the day somebody renames a variable.
   */
  brand?: BrandTokens
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
  /**
   * The firm's people, for a `team` block (Phase 183).
   *
   * Supplied rather than held in the block, the same decision `pricingTable`
   * makes: a bio copied into a document is a second copy of a paragraph that
   * will be edited once, and the stale one is what the client reads.
   *
   * The whole **pool** `teamForDocument` read, not one block's selection —
   * `selectTeam` does the choosing in the renderer, so a document with two team
   * blocks is still one query and the two blocks cannot be served the same list.
   */
  teamMembers?: RenderedTeamMember[]
  /**
   * The pixel size of each asset a block places, for a crop (Phase 186).
   *
   * Needed, not decorative. A cropped box has to take the **cropped** shape,
   * and CSS can only work that out from the source's aspect ratio — so without
   * this a crop is not expressible on the page at all. `assets.width` and
   * `assets.height` have existed since Phase 4 and were never written; Phase
   * 186 measures them at upload because of this line.
   *
   * Absent for an asset uploaded before then, and the renderer shows the whole
   * picture rather than guessing — stated in `ImageBlock`.
   */
  assetSizes?: Record<string, { width: number; height: number }>
  /**
   * Pre-rendered QR SVG markup, keyed by block id. Encoding happens on the
   * server so the same markup works in the browser, in print, and in email.
   */
  qrCodes?: Record<string, string>
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
    case 'table':
      return <TableBlock block={block} />
    case 'team':
      return <TeamBlock block={block} pool={data.teamMembers ?? []} data={data} />
    case 'pricingTable':
      return <PricingBlock block={block} data={data} />
    case 'image':
      return (
        <ImageBlock
          block={block}
          assetUrl={data.assetUrl}
          size={block.assetId ? data.assetSizes?.[block.assetId] : undefined}
        />
      )
    case 'columns':
      return <ColumnsBlock block={block} />
    case 'clause':
      return <ClauseBlock block={block} />
    case 'signature':
      return <SignatureBlock block={block} slot={data.signatureSlot} />
    case 'button':
      return <ButtonBlock block={block} />
    case 'qrCode':
      return <QrCodeBlock block={block} data={data} />
    case 'video':
      return <VideoBlock block={block} assetUrl={data.assetUrl} />
    case 'shape':
      return <ShapeBlock block={block} brand={data.brand} />
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

/**
 * A call to action (spec §8).
 *
 * Still an anchor, so it degrades to a plain link in print and in email
 * clients that strip styling.
 */
/**
 * A plain table (Phase 181, §7).
 *
 * `normalizeTable` rather than reading `block.rows` directly, so a table stored
 * ragged renders padded here exactly as it does in the PDF and the email. Three
 * renderers reading the raw rows is how one document becomes three documents.
 */
/**
 * The firm's people (Phase 183, §15).
 *
 * `data.teamMembers` is the document's **pool** — the active directory plus any
 * retired person a block names — and `selectTeam` picks this block's people out
 * of it. Shared with the PDF and the email, so a block cannot name three people
 * and show two of them on paper.
 */
function TeamBlock({
  block,
  pool,
  data,
}: {
  block: Extract<Block, { type: 'team' }>
  pool: RenderedTeamMember[]
  data: RenderData
}) {
  const members = selectTeam(pool, block.memberIds)

  // Nothing rather than an empty heading: a "Who you will be working with"
  // section with no people under it reads as a rendering fault.
  if (members.length === 0) return null

  return (
    <div className="doc-block doc-team-block">
      {block.title && <p className="doc-team-title">{block.title}</p>}
      <ul className={block.layout === 'grid' ? 'doc-team-grid' : 'doc-team-list'}>
        {members.map((member) => (
          <li key={member.id} className="doc-team-member">
            {block.showPhotos && member.headshotAssetId && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.assetUrl(member.headshotAssetId)}
                alt={member.name}
                className="doc-team-photo"
                // The outline, shared with the PDF's clipping path (Phase 186).
                style={{
                  borderRadius:
                    block.photoShape === 'circle'
                      ? '50%'
                      : block.photoShape === 'rounded'
                        ? `${ROUNDED_MASK_FRACTION * 100}%`
                        : undefined,
                }}
              />
            )}
            <div>
              <p className="doc-team-name">
                {member.name}
                {block.showQualifications && member.qualifications && (
                  <span className="doc-team-quals">, {member.qualifications}</span>
                )}
              </p>
              {member.title && <p className="doc-team-role">{member.title}</p>}
              {member.bio &&
                member.bio
                  .split(/\n{2,}/)
                  .filter((paragraph) => paragraph.trim())
                  .map((paragraph, index) => (
                    <p key={index} className="doc-team-bio">
                      {paragraph}
                    </p>
                  ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TableBlock({ block }: { block: Extract<Block, { type: 'table' }> }) {
  const { width, header, rows, align } = normalizeTable(block)
  if (width === 0) return null

  const rule = block.style === 'plain' ? 'none' : '1px solid var(--doc-rule)'

  return (
    <div className="doc-block doc-table-block">
      {block.title && <p className="doc-table-title">{block.title}</p>}
      <table className="doc-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
        {header.length > 0 && (
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th
                  key={index}
                  scope="col"
                  style={{
                    textAlign: align[index],
                    borderBottom: block.style === 'plain' ? 'none' : '2px solid var(--doc-rule)',
                    borderRight: block.style === 'grid' && index < width - 1 ? rule : 'none',
                    padding: '6px 8px',
                    fontWeight: 600,
                  }}
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  style={{
                    textAlign: align[index],
                    // `rows` rules between rows and `grid` also between cells;
                    // neither puts a rule after the last of either, which is
                    // what makes a bordered table look drawn rather than boxed.
                    borderTop: block.style === 'plain' || rowIndex === 0 ? 'none' : rule,
                    borderRight: block.style === 'grid' && index < width - 1 ? rule : 'none',
                    padding: '6px 8px',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ButtonBlock({ block }: { block: Extract<Block, { type: 'button' }> }) {
  if (!block.label) return null

  return (
    <p className="doc-button-wrap" style={{ textAlign: block.align }}>
      <a
        href={safeUrl(block.url)}
        className={`doc-button doc-button-${block.style}`}
        rel="noopener noreferrer"
      >
        {block.label}
      </a>
    </p>
  )
}

/**
 * A QR code (spec §8).
 *
 * `data.qrCodes` carries pre-rendered SVG markup keyed by block id — encoding
 * happens on the server so the markup is identical in the browser, in print,
 * and in an email where no script runs.
 */
/**
 * A drawn primitive (Phase 193, §7's *vector primitives*).
 *
 * The markup comes from `shapeSvg`, the same function the PDF draws from, so
 * the page and the paper cannot disagree about what was placed. It is
 * generated from the block's parameters — the author never writes markup —
 * which is why it can be inlined without a sanitiser standing between.
 */
function ShapeBlock({
  block,
  brand,
}: {
  block: Extract<Block, { type: 'shape' }>
  brand?: BrandTokens
}) {
  const colors = brand ?? DEFAULT_BRAND
  /*
    The box in CSS, and the same box in the markup's own units. A shape is
    the one drawing here that should not keep an aspect ratio: a panel is as
    wide as the author made it, and `preserveAspectRatio="none"` is how the
    browser is told the viewBox is a box rather than a picture.
  */
  const svg = shapeSvg(block, colors, { width: 1000, height: block.heightPt })

  return (
    <div style={{ textAlign: block.align }}>
      <div
        style={{
          display: 'inline-block',
          width: `${block.widthPercent}%`,
          height: `${block.heightPt}pt`,
          lineHeight: 0,
        }}
        aria-hidden="true"
        // Generated from the block's own fields by `shapeSvg`; never
        // author-written markup.
        dangerouslySetInnerHTML={{
          __html: svg.replace('<svg ', '<svg preserveAspectRatio="none" style="width:100%;height:100%" '),
        }}
      />
    </div>
  )
}

function QrCodeBlock({
  block,
  data,
}: {
  block: Extract<Block, { type: 'qrCode' }>
  data: RenderData
}) {
  const svg = data.qrCodes?.[block.id]

  return (
    <figure className="doc-qr" style={{ textAlign: block.align }}>
      {svg ? (
        <div
          style={{ width: `${block.sizePt}pt`, display: 'inline-block' }}
          // Generated server-side by the qrcode library from the block's own
          // value; never user-authored markup.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        // The designer's preview runs in the browser, where the server-side
        // encoder is unavailable. A labelled placeholder shows the author what
        // will be encoded rather than leaving a gap where a code will appear.
        <div
          className="doc-qr-placeholder"
          style={{ width: `${block.sizePt}pt`, height: `${block.sizePt}pt` }}
        >
          <span>QR</span>
          <small>{block.value || 'no value yet'}</small>
        </div>
      )}
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  )
}

/** Linked video, rendered as a thumbnail (spec §8). */
function VideoBlock({
  block,
  assetUrl,
}: {
  block: Extract<Block, { type: 'video' }>
  assetUrl: (assetId: string) => string
}) {
  if (!block.url) return null

  return (
    <figure className="doc-video" style={{ width: `${block.widthPercent}%` }}>
      <a href={safeUrl(block.url)} rel="noopener noreferrer">
        {block.thumbnailAssetId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetUrl(block.thumbnailAssetId)} alt={block.caption || 'Watch the video'} />
        ) : (
          <span className="doc-video-placeholder">Watch the video</span>
        )}
      </a>
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  )
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

/**
 * A picture, cropped and masked (spec §7, Phase 186).
 *
 * The crop is a box with `overflow: hidden` and the **cropped** aspect ratio,
 * holding an image sized `100 / crop.width` and `100 / crop.height` percent of
 * that box and offset so the chosen part lands inside. Percentages all the way
 * down, so the browser does the arithmetic and a resized window keeps the crop.
 *
 * The source's own ratio is what makes the box the right shape, which is why
 * `assetSizes` is required rather than nice to have. Without it the whole
 * picture is shown: a crop guessed from a wrong ratio is worse than no crop,
 * because the author would see one framing and the client another.
 *
 * The mask is `border-radius`, and `ROUNDED_MASK_FRACTION` is shared with the
 * Bézier path the PDF writes — a corner that is rounder on screen than on paper
 * is two documents.
 */
function ImageBlock({
  block,
  assetUrl,
  size,
}: {
  block: Extract<Block, { type: 'image' }>
  assetUrl: (assetId: string) => string
  size?: { width: number; height: number }
}) {
  if (!block.assetId) return null

  const crop = normalizeCrop(block.crop)
  const radius =
    block.maskShape === 'circle'
      ? '50%'
      : block.maskShape === 'rounded'
        ? `${ROUNDED_MASK_FRACTION * 100}%`
        : undefined

  const cropped = size && !isWholeImage(crop)

  if (!cropped) {
    return (
      <figure className="doc-figure" style={{ textAlign: block.align }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={assetUrl(block.assetId)}
          alt={block.caption || ''}
          style={{ width: `${block.widthPercent}%`, borderRadius: radius }}
        />
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>
    )
  }

  return (
    <figure className="doc-figure" style={{ textAlign: block.align }}>
      <span
        className="doc-crop"
        style={{
          width: `${block.widthPercent}%`,
          aspectRatio: `${crop.width * size.width} / ${crop.height * size.height}`,
          borderRadius: radius,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={assetUrl(block.assetId)}
          alt={block.caption || ''}
          style={{
            width: `${100 / crop.width}%`,
            height: `${100 / crop.height}%`,
            left: `${(-crop.x * 100) / crop.width}%`,
            top: `${(-crop.y * 100) / crop.height}%`,
          }}
        />
      </span>
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
