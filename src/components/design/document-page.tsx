import './document.css'
import { parseBlocks, visibleBlocks, type Block } from '@/modules/design/blocks'
import { resolveBlocks, type MergeContext } from '@/modules/design/merge-fields'
import {
  BlockView,
  DEFAULT_BRAND,
  contentWidthPt,
  documentStyle,
  type BrandTokens,
  type RenderData,
} from './document-render'

/**
 * Renders a whole design document (spec §7).
 *
 * Merge fields are resolved here rather than being stored resolved, so the
 * document stays reusable as a template and always shows current data.
 */

export type DocumentSetup = {
  pageSize: string
  orientation: string
  marginTopPt: number
  marginRightPt: number
  marginBottomPt: number
  marginLeftPt: number
  headerText?: string | null
  footerText?: string | null
}

export function DocumentPage({
  blocks,
  audience,
  setup,
  brand,
  context,
  data,
}: {
  blocks: unknown
  /**
   * Who is looking at this (Phase 191, §7's `lock/hide`).
   *
   * Required, with no default, which is the whole mechanism. This component
   * renders the client's page *and* the designer's preview, and a block the
   * author hid must vanish from the first and stay — marked — in the second.
   * A defaulted prop would make one of those two the answer for a caller that
   * never thought about the question; a required one makes every call site
   * say which page it is.
   */
  audience: 'author' | 'reader'
  setup: DocumentSetup
  brand?: BrandTokens | null
  context: MergeContext
  data: RenderData
}) {
  const tokens = brand ?? DEFAULT_BRAND
  const all: Block[] = resolveBlocks(parseBlocks(blocks), context)
  const parsed = audience === 'reader' ? visibleBlocks(all) : all

  // The resolved brand travels with the data so a `shape` resolves its paint
  // the same way the PDF does (Phase 193).
  const withBrand: RenderData = { ...data, brand: tokens }

  const style: React.CSSProperties = {
    ...documentStyle(tokens),
    ['--doc-content-width' as string]: `${contentWidthPt(setup.pageSize, setup.marginLeftPt, setup.marginRightPt)}pt`,
    ['--doc-margin-top' as string]: `${setup.marginTopPt}pt`,
    ['--doc-margin-right' as string]: `${setup.marginRightPt}pt`,
    ['--doc-margin-bottom' as string]: `${setup.marginBottomPt}pt`,
    ['--doc-margin-left' as string]: `${setup.marginLeftPt}pt`,
    ['--doc-page-size' as string]: setup.pageSize,
    ['--doc-page-orientation' as string]: setup.orientation,
  }

  if (parsed.length === 0) {
    return (
      <article className="doc" style={style}>
        <p style={{ color: tokens.mutedColor }}>
          This document is empty. Add a block to get started.
        </p>
      </article>
    )
  }

  return (
    <article className="doc" style={style}>
      {setup.headerText && <p className="doc-running-header">{setup.headerText}</p>}

      {parsed.map((block) =>
        block.hidden ? (
          /*
            Only an author reaches this branch, and they have to: a held-back
            block that simply vanished from the preview would look deleted,
            and the author would write it again. Marked rather than styled
            away, so the preview answers "what will the client see" and "what
            is in this document" at once.
          */
          <div key={block.id} className="doc-hidden-block" data-hidden="true">
            <p className="doc-hidden-label">Hidden — not sent to the client</p>
            <BlockView block={block} data={withBrand} />
          </div>
        ) : (
          <BlockView key={block.id} block={block} data={withBrand} />
        ),
      )}

      {setup.footerText && (
        <footer className="doc-running-footer">
          <hr className="doc-divider" />
          <p style={{ fontSize: '0.85em', color: tokens.mutedColor, whiteSpace: 'pre-line' }}>
            {setup.footerText}
          </p>
        </footer>
      )}
    </article>
  )
}

/** Maps a brand kit row onto renderer tokens, filling gaps with defaults. */
export function brandTokens(
  kit:
    | {
        primaryColor: string
        accentColor: string
        textColor: string
        mutedColor: string
        surfaceColor: string
        headingFont: string
        bodyFont: string
        baseSizePt: number
      }
    | null
    | undefined,
): BrandTokens {
  if (!kit) return DEFAULT_BRAND
  return {
    primaryColor: kit.primaryColor,
    accentColor: kit.accentColor,
    textColor: kit.textColor,
    mutedColor: kit.mutedColor,
    surfaceColor: kit.surfaceColor,
    headingFont: kit.headingFont,
    bodyFont: kit.bodyFont,
    baseSizePt: kit.baseSizePt,
  }
}
