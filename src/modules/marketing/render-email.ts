import { normalizeTable, visibleBlocks, type Block } from '@/modules/design/blocks'
import type { ShapePaint } from '@/modules/design/shapes'
import { selectTeam, type RenderedTeamMember } from '@/modules/studio/team'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import { safeUrl } from '@/modules/design/urls'

/**
 * Renders design blocks as email HTML (spec §8).
 *
 * A second renderer for the same blocks, and deliberately not the React one.
 * Email clients are two decades behind browsers: no external stylesheets, no
 * flexbox or grid in Outlook, no `<style>` at all in Gmail's clipped view. So
 * this emits tables with inline styles — the format that actually arrives
 * looking like it was meant to.
 *
 * This is why ADR 0004 chose flowing blocks over a positioned canvas. The same
 * document renders here because it was never tied to coordinates.
 */

const CONTENT_WIDTH = 600

/** Escapes text for HTML. Every author string passes through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
}

export type EmailBrand = {
  primaryColor: string
  /**
   * Added in Phase 193, when a `shape` block could first be painted with it.
   *
   * Until then nothing in an email used the accent, so its absence here cost
   * nothing. It stopped being free the moment an author could pick "accent"
   * in the designer: a shape they set to the accent colour would have come
   * out the primary one in the send, and the page and the email would have
   * disagreed about a colour somebody chose on purpose.
   */
  accentColor: string
  textColor: string
  mutedColor: string
  bodyFont: string
  headingFont: string
}

/**
 * The kit an email uses when the company has none.
 *
 * The **colours** come from `DEFAULT_BRAND_KIT` — this was a seventh written-out
 * copy of them, missed by Phase 79 because it is a different type in a
 * different module and does not mention `BrandTokens`.
 *
 * The **fonts** are deliberately not the kit's. A document renders in a browser
 * that has `system-ui`; an email renders in Outlook, which does not, so the
 * stack names the real families each platform ships. Same rule, different
 * medium — the one place the two are allowed to differ.
 */
const DEFAULT_EMAIL_BRAND: EmailBrand = {
  primaryColor: DEFAULT_BRAND_KIT.primaryColor,
  accentColor: DEFAULT_BRAND_KIT.accentColor,
  textColor: DEFAULT_BRAND_KIT.textColor,
  mutedColor: DEFAULT_BRAND_KIT.mutedColor,
  bodyFont: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  headingFont: 'Georgia, serif',
}

/**
 * A stored brand kit as this renderer wants it.
 *
 * The body font stays the email stack rather than the kit's: see above. The
 * heading font is the company's, because a heading is where a brand is actually
 * seen and Georgia degrades gracefully wherever the choice does not resolve.
 */
export function emailBrand(
  kit: {
    primaryColor: string
    accentColor?: string
    textColor: string
    mutedColor: string
    headingFont: string
  } | null,
): EmailBrand {
  if (!kit) return DEFAULT_EMAIL_BRAND

  return {
    primaryColor: kit.primaryColor,
    // Optional on the way in, because a caller holding an older shape of kit
    // should not stop rendering; the default is a colour, not a blank.
    accentColor: kit.accentColor ?? DEFAULT_EMAIL_BRAND.accentColor,
    textColor: kit.textColor,
    mutedColor: kit.mutedColor,
    headingFont: kit.headingFont,
    bodyFont: DEFAULT_EMAIL_BRAND.bodyFont,
  }
}

/**
 * A brand value on its way into a `style` attribute.
 *
 * Belt and braces (Phase 80). `studio/service` refuses any colour that is not
 * plain hex and any font that is not a font list, so nothing that reaches here
 * should need escaping — but this file's own rule is that *every author string
 * passes through `escapeHtml`*, and these are author strings that quietly did
 * not. A validator three modules away is a promise; this is the second lock.
 *
 * Entities are decoded by the HTML parser before the CSS is parsed, so a
 * legitimate `'Segoe UI'` still resolves after its quotes are escaped.
 */
function styleValue(value: string): string {
  return escapeHtml(value)
}

/**
 * Rewrites an outbound link so a click is recorded (spec §10).
 *
 * Identity by default. When a campaign supplies one, every author-entered link
 * passes through it, so tracking is applied in exactly one place instead of
 * being remembered at each call site.
 */
export type LinkWrapper = (url: string) => string

const NO_TRACKING: LinkWrapper = (url) => url

/** Renders one block as email-safe HTML. */
function blockHtml(
  block: Block,
  brand: EmailBrand,
  track: LinkWrapper,
  team: RenderedTeamMember[],
): string {
  switch (block.type) {
    case 'cover':
      return `
        <tr><td style="padding:32px 24px;background:${styleValue(brand.primaryColor)};color:#ffffff;">
          ${block.title ? `<h1 style="margin:0;font-family:${styleValue(brand.headingFont)};font-size:26px;line-height:1.2;color:#ffffff;">${escapeHtml(block.title)}</h1>` : ''}
          ${block.subtitle ? `<p style="margin:8px 0 0;font-size:14px;color:#ffffff;opacity:0.9;">${escapeHtml(block.subtitle)}</p>` : ''}
        </td></tr>`

    case 'heading': {
      const size = block.level === 1 ? 24 : block.level === 2 ? 19 : 16
      return `
        <tr><td style="padding:20px 24px 6px;">
          <h${block.level} style="margin:0;font-family:${styleValue(brand.headingFont)};font-size:${size}px;line-height:1.3;color:${styleValue(brand.primaryColor)};text-align:${block.align};">${escapeHtml(block.text)}</h${block.level}>
        </td></tr>`
    }

    case 'text':
      return `
        <tr><td style="padding:6px 24px;">
          ${paragraphs(block.text)
            .map(
              (p) =>
                `<p style="margin:0 0 12px;font-size:${block.emphasis ? 17 : 15}px;line-height:1.6;color:${styleValue(brand.textColor)};text-align:${block.align};">${escapeHtml(p)}</p>`,
            )
            .join('')}
        </td></tr>`

    case 'list':
      return `
        <tr><td style="padding:6px 24px;">
          <${block.ordered ? 'ol' : 'ul'} style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;color:${styleValue(brand.textColor)};">
            ${block.items.filter((i) => i.trim()).map((i) => `<li style="margin-bottom:6px;">${escapeHtml(i)}</li>`).join('')}
          </${block.ordered ? 'ol' : 'ul'}>
        </td></tr>`

    case 'keyValue':
      return `
        <tr><td style="padding:6px 24px;">
          ${block.title ? `<p style="margin:0 0 8px;font-weight:600;color:${styleValue(brand.textColor)};">${escapeHtml(block.title)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${block.rows
              .filter((row) => row.value.trim())
              .map(
                (row) =>
                  `<tr><td style="padding:4px 12px 4px 0;font-size:14px;color:${styleValue(brand.mutedColor)};white-space:nowrap;">${escapeHtml(row.label)}</td><td style="padding:4px 0;font-size:14px;color:${styleValue(brand.textColor)};">${escapeHtml(row.value)}</td></tr>`,
              )
              .join('')}
          </table>
        </td></tr>`

    case 'table': {
      /*
        A real `<table>` with `role="presentation"` left off, deliberately: this
        one *is* tabular data, and the attribute that tells a screen reader to
        ignore the structure is exactly wrong here. Every other table in this
        renderer is layout and carries it.

        Borders inline on each cell rather than on the table, because Outlook
        ignores `border-collapse` and renders a collapsed table's rules twice.
      */
      const { width, header, rows, align } = normalizeTable(block)
      if (width === 0) return ''

      const rule = block.style === 'plain' ? 'none' : `1px solid ${styleValue(brand.mutedColor)}`
      const cell = (
        content: string,
        index: number,
        rowIndex: number,
        heading: boolean,
      ) =>
        `<t${heading ? 'h' : 'd'} style="padding:6px 8px;font-size:14px;text-align:${align[index]};` +
        `color:${styleValue(heading ? brand.textColor : brand.textColor)};` +
        `font-weight:${heading ? 600 : 400};` +
        `border-bottom:${heading && block.style !== 'plain' ? `2px solid ${styleValue(brand.mutedColor)}` : 'none'};` +
        `border-top:${!heading && rowIndex > 0 ? rule : 'none'};` +
        `border-right:${block.style === 'grid' && index < width - 1 ? rule : 'none'};">` +
        `${escapeHtml(content)}</t${heading ? 'h' : 'd'}>`

      return `
        <tr><td style="padding:6px 24px;">
          ${block.title ? `<p style="margin:0 0 8px;font-weight:600;color:${styleValue(brand.textColor)};">${escapeHtml(block.title)}</p>` : ''}
          <table cellpadding="0" cellspacing="0" width="100%">
            ${header.length > 0 ? `<thead><tr>${header.map((text, index) => cell(text, index, 0, true)).join('')}</tr></thead>` : ''}
            <tbody>
              ${rows.map((row, rowIndex) => `<tr>${row.map((text, index) => cell(text, index, rowIndex, false)).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </td></tr>`
    }

    case 'columns':
      // Stacked rather than side by side: Outlook does not do grid, and a
      // single column is what a phone shows anyway.
      return block.columns
        .map(
          (column) => `
        <tr><td style="padding:10px 24px;">
          ${column.heading ? `<p style="margin:0 0 4px;font-family:${styleValue(brand.headingFont)};font-size:16px;color:${styleValue(brand.primaryColor)};">${escapeHtml(column.heading)}</p>` : ''}
          ${paragraphs(column.body).map((p) => `<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:${styleValue(brand.textColor)};">${escapeHtml(p)}</p>`).join('')}
        </td></tr>`,
        )
        .join('')

    case 'button': {
      const url = track(safeUrl(block.url))
      const solid = block.style === 'solid'
      return `
        <tr><td style="padding:16px 24px;text-align:${block.align};">
          <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:600;text-decoration:none;${
            solid
              ? `background:${styleValue(brand.primaryColor)};color:#ffffff;`
              : `border:2px solid ${styleValue(brand.primaryColor)};color:${styleValue(brand.primaryColor)};`
          }">${escapeHtml(block.label)}</a>
        </td></tr>`
    }

    case 'image':
      // Images are served from an absolute URL by the caller; a block with no
      // asset renders nothing rather than a broken frame.
      return ''

    case 'video': {
      const url = track(safeUrl(block.url))
      return `
        <tr><td style="padding:16px 24px;text-align:center;">
          <a href="${escapeHtml(url)}" style="display:inline-block;padding:24px 32px;border-radius:6px;background:#f1f5f9;color:${styleValue(brand.primaryColor)};font-weight:600;text-decoration:none;">
            ${escapeHtml(block.caption || 'Watch the video')}
          </a>
        </td></tr>`
    }

    case 'qrCode':
      // A QR code in an email is pointless — the reader is already on a device
      // that can follow a link. Dropped rather than shipped as a blank box.
      return ''

    case 'shape': {
      /*
        A shape in an email is a styled table cell, not the SVG the page and
        the PDF draw (Phase 193).

        The one place this engine renders a block differently rather than
        from the shared markup, and it is the medium's doing: Gmail strips
        inline SVG, so a shape drawn that way would be a gap in the message
        for most of a list. A rectangle *is* a background colour with a
        border radius, and that is as well supported as anything in email.

        It degrades, and predictably: an ellipse is `border-radius:50%`,
        which Outlook's renderer squares off, and a line is a bordered row.
        Named rather than hidden, because a marketing creative is laid out by
        somebody who should know what the least capable client will show.
      */
      const colour = (paint: ShapePaint) =>
        paint === 'primary'
          ? brand.primaryColor
          : paint === 'accent'
            ? brand.accentColor
            : paint === 'text'
              ? brand.textColor
              : paint === 'muted'
                ? brand.mutedColor
                : 'transparent'

      /*
        `align` and `widthPercent` are honoured here, which the first version
        was not — seen by rendering the three surfaces side by side and
        noticing that a centred shape sat left in the email and a 40% line ran
        the full width. `text-align` on the cell with `display:inline-block`
        on the box, rather than `margin:0 auto`, because Outlook ignores auto
        margins and respects the cell.
      */
      const cell = `padding:6px 24px;text-align:${block.align};`

      if (block.shape === 'line') {
        const thickness = Math.max(0.5, block.strokeWidthPt)
        return (
          `<tr><td style="${cell}">` +
          `<div style="display:inline-block;width:${block.widthPercent}%;height:${thickness}px;` +
          `background:${styleValue(colour(block.stroke === 'none' ? 'text' : block.stroke))};` +
          `font-size:0;line-height:0;">&nbsp;</div>` +
          `</td></tr>`
        )
      }

      const radius = block.shape === 'ellipse' ? '50%' : `${block.cornerRadiusPt}px`
      const border =
        block.stroke === 'none' || block.strokeWidthPt <= 0
          ? ''
          : `border:${block.strokeWidthPt}px solid ${styleValue(colour(block.stroke))};`

      return (
        `<tr><td style="${cell}">` +
        `<div style="display:inline-block;box-sizing:border-box;width:${block.widthPercent}%;` +
        `height:${block.heightPt}px;background:${styleValue(colour(block.fill))};` +
        `border-radius:${radius};${border}font-size:0;line-height:0;">&nbsp;</div>` +
        `</td></tr>`
      )
    }

    case 'divider':
      return `<tr><td style="padding:12px 24px;"><hr style="border:0;border-top:1px solid #e2e8f0;margin:0;" /></td></tr>`

    case 'spacer':
      return `<tr><td style="height:${block.heightPt}px;line-height:${block.heightPt}px;">&nbsp;</td></tr>`

    case 'clause':
      return `
        <tr><td style="padding:6px 24px;">
          ${block.title ? `<p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${styleValue(brand.textColor)};">${escapeHtml(block.title)}</p>` : ''}
          ${paragraphs(block.body).map((p) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${styleValue(brand.mutedColor)};">${escapeHtml(p)}</p>`).join('')}
        </td></tr>`

    case 'team': {
      /*
        The firm's people (Phase 183, §15).

        Not a proposal-only block: §15 ends *"brand assets feed both the Proposal
        Designer and Marketing Creative Studio"*, and "meet the people you would
        be working with" is a newsletter section as much as a capability
        statement's. So the palette offers it in both kinds and this surface has
        to mean it.

        Stacked `<tr>`s rather than the block's `grid` layout, for the reason
        `columns` gives above: Outlook does not do grid and a phone shows one
        column anyway. `layout` is therefore honoured on the page and in the
        designer and ignored here — the same shape as `showPhotos` below.

        Headshots are not emitted, exactly as `image` emits nothing: this
        renderer has no absolute asset URL to put in a `src`, and a broken image
        icon beside somebody's name is worse than their name set plainly. The
        difference from `image` is that the rest of the block still carries its
        content, so this is a degraded section rather than a dropped one.
      */
      const members = selectTeam(team, block.memberIds)
      if (members.length === 0) return ''

      return `
        <tr><td style="padding:10px 24px;">
          ${block.title ? `<p style="margin:0 0 10px;font-family:${styleValue(brand.headingFont)};font-size:17px;color:${styleValue(brand.primaryColor)};">${escapeHtml(block.title)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${members
              .map(
                (member) => `
            <tr><td style="padding:0 0 14px;">
              <p style="margin:0;font-size:15px;font-weight:600;color:${styleValue(brand.textColor)};">${escapeHtml(member.name)}${
                block.showQualifications && member.qualifications
                  ? `<span style="font-weight:400;color:${styleValue(brand.mutedColor)};">, ${escapeHtml(member.qualifications)}</span>`
                  : ''
              }</p>
              ${member.title ? `<p style="margin:2px 0 0;font-size:13px;color:${styleValue(brand.mutedColor)};">${escapeHtml(member.title)}</p>` : ''}
              ${member.bio ? paragraphs(member.bio).map((paragraph) => `<p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:${styleValue(brand.textColor)};">${escapeHtml(paragraph)}</p>`).join('') : ''}
            </td></tr>`,
              )
              .join('')}
          </table>
        </td></tr>`
    }

    // Proposal-only blocks never appear in a marketing document, but a
    // document could in principle carry one — render nothing rather than
    // leaking a fee table into a newsletter.
    case 'pricingTable':
    case 'signature':
    case 'pageBreak':
    default:
      return ''
  }
}

/**
 * The full HTML email.
 *
 * Includes the unsubscribe link in the visible footer as well as the
 * `List-Unsubscribe` header the provider sets — spec §10 requires maintaining
 * unsubscribe status, and a person should not have to hunt for the link.
 */
export function renderEmailHtml(input: {
  blocks: Block[]
  previewText?: string | null
  unsubscribeUrl: string
  trackUrl?: string
  footer?: string | null
  brand?: EmailBrand
  trackLink?: LinkWrapper
  /**
   * The firm's people, for a `team` block (Phase 183).
   *
   * The document's pool, as `teamForDocument` reads it. Optional because most
   * campaigns carry no team block — and a campaign that does and is sent without
   * this gets a section with no people in it rather than a wrong one.
   */
  team?: RenderedTeamMember[]
}): string {
  const brand = input.brand ?? DEFAULT_EMAIL_BRAND
  const track = input.trackLink ?? NO_TRACKING
  const team = input.team ?? []
  /*
    A hidden block is not sent (Phase 191, §7's `lock/hide`). There is no
    author audience for an email: a campaign goes to a list, at once, and
    cannot be recalled — which makes this the surface where a held-back block
    costs the most and the one most likely to have one, since a creative being
    drafted usually sits beside the one going out.
  */
  const body = visibleBlocks(input.blocks)
    .map((block) => blockHtml(block, brand, track, team))
    .join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>&nbsp;</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:${styleValue(brand.bodyFont)};">
${
  input.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.previewText)}</div>`
    : ''
}
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="${CONTENT_WIDTH}" style="max-width:${CONTENT_WIDTH}px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
      ${body}
      <tr><td style="padding:20px 24px;border-top:1px solid #e2e8f0;">
        ${input.footer ? `<p style="margin:0 0 8px;font-size:12px;color:${styleValue(brand.mutedColor)};">${escapeHtml(input.footer)}</p>` : ''}
        <p style="margin:0;font-size:12px;color:${styleValue(brand.mutedColor)};">
          <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${styleValue(brand.mutedColor)};text-decoration:underline;">Unsubscribe from these emails</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
${
  input.trackUrl
    ? `<img src="${escapeHtml(input.trackUrl)}" width="1" height="1" alt="" style="display:block;border:0;" />`
    : ''
}
</body>
</html>`
}

/**
 * The plain-text alternative.
 *
 * Not optional: a message with no text part is a spam signal, and some readers
 * genuinely prefer it.
 */
export function renderEmailText(input: {
  blocks: Block[]
  unsubscribeUrl: string
  trackLink?: LinkWrapper
  /** The pool a `team` block selects from, as in `renderEmailHtml`. */
  team?: RenderedTeamMember[]
}): string {
  const lines: string[] = []
  const track = input.trackLink ?? NO_TRACKING
  const team = input.team ?? []

  // The plain-text alternative of the same message, and a separate switch:
  // two dispatches, so two calls (Phase 191).
  for (const block of visibleBlocks(input.blocks)) {
    switch (block.type) {
      case 'cover':
        if (block.title) lines.push(block.title.toUpperCase(), '')
        if (block.subtitle) lines.push(block.subtitle, '')
        break
      case 'heading':
        lines.push('', block.text, '-'.repeat(Math.min(block.text.length, 60)), '')
        break
      case 'text':
        lines.push(...paragraphs(block.text), '')
        break
      case 'list':
        lines.push(...block.items.filter((i) => i.trim()).map((i) => `  • ${i}`), '')
        break
      case 'keyValue':
        if (block.title) lines.push(block.title)
        lines.push(
          ...block.rows.filter((r) => r.value.trim()).map((r) => `  ${r.label}: ${r.value}`),
          '',
        )
        break
      case 'table': {
        /*
          Column-aligned with spaces rather than comma-separated, because the
          plain-text alternative is read by someone who chose it and a table
          flattened to prose is the one block that loses its meaning entirely
          without its shape.

          Widths from the widest cell in each column, capped so one long cell
          cannot push the rest off an 80-column terminal.
        */
        const { width, header, rows } = normalizeTable(block)
        if (width === 0) break

        if (block.title) lines.push(block.title)

        const all = header.length > 0 ? [header, ...rows] : rows
        const widths = Array.from({ length: width }, (_, index) =>
          Math.min(Math.max(...all.map((row) => row[index].length), 1), 24),
        )
        const line = (row: string[]) =>
          '  ' + row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()

        if (header.length > 0) {
          lines.push(line(header))
          lines.push('  ' + widths.map((w) => '-'.repeat(w)).join('  '))
        }
        lines.push(...rows.map(line), '')
        break
      }
      case 'columns':
        for (const column of block.columns) {
          if (column.heading) lines.push(column.heading)
          lines.push(...paragraphs(column.body), '')
        }
        break
      case 'button':
        lines.push(`${block.label}: ${track(safeUrl(block.url))}`, '')
        break
      case 'video':
        lines.push(`${block.caption || 'Watch the video'}: ${track(safeUrl(block.url))}`, '')
        break
      case 'team': {
        /*
          Name, qualifications and role on one line, bio under it. No photograph
          to lose here, so this part is not degraded the way the HTML's is — the
          plain-text alternative carries everything the block actually says.
        */
        const members = selectTeam(team, block.memberIds)
        if (members.length === 0) break

        if (block.title) lines.push(block.title, '')
        for (const member of members) {
          const qualified =
            block.showQualifications && member.qualifications
              ? `${member.name}, ${member.qualifications}`
              : member.name
          lines.push(member.title ? `${qualified} — ${member.title}` : qualified)
          if (member.bio) lines.push(...paragraphs(member.bio))
          lines.push('')
        }
        break
      }
      case 'clause':
        if (block.title) lines.push(block.title)
        lines.push(...paragraphs(block.body), '')
        break
      default:
        break
    }
  }

  lines.push('', '---', `Unsubscribe: ${input.unsubscribeUrl}`)
  return lines.join('\n')
}
