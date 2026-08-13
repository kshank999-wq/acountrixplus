import type { Block } from '@/modules/design/blocks'
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
  textColor: string
  mutedColor: string
  bodyFont: string
  headingFont: string
}

const DEFAULT_EMAIL_BRAND: EmailBrand = {
  primaryColor: '#0d6e60',
  textColor: '#0f172a',
  mutedColor: '#64748b',
  bodyFont: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  headingFont: 'Georgia, serif',
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
function blockHtml(block: Block, brand: EmailBrand, track: LinkWrapper): string {
  switch (block.type) {
    case 'cover':
      return `
        <tr><td style="padding:32px 24px;background:${brand.primaryColor};color:#ffffff;">
          ${block.title ? `<h1 style="margin:0;font-family:${brand.headingFont};font-size:26px;line-height:1.2;color:#ffffff;">${escapeHtml(block.title)}</h1>` : ''}
          ${block.subtitle ? `<p style="margin:8px 0 0;font-size:14px;color:#ffffff;opacity:0.9;">${escapeHtml(block.subtitle)}</p>` : ''}
        </td></tr>`

    case 'heading': {
      const size = block.level === 1 ? 24 : block.level === 2 ? 19 : 16
      return `
        <tr><td style="padding:20px 24px 6px;">
          <h${block.level} style="margin:0;font-family:${brand.headingFont};font-size:${size}px;line-height:1.3;color:${brand.primaryColor};text-align:${block.align};">${escapeHtml(block.text)}</h${block.level}>
        </td></tr>`
    }

    case 'text':
      return `
        <tr><td style="padding:6px 24px;">
          ${paragraphs(block.text)
            .map(
              (p) =>
                `<p style="margin:0 0 12px;font-size:${block.emphasis ? 17 : 15}px;line-height:1.6;color:${brand.textColor};text-align:${block.align};">${escapeHtml(p)}</p>`,
            )
            .join('')}
        </td></tr>`

    case 'list':
      return `
        <tr><td style="padding:6px 24px;">
          <${block.ordered ? 'ol' : 'ul'} style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;color:${brand.textColor};">
            ${block.items.filter((i) => i.trim()).map((i) => `<li style="margin-bottom:6px;">${escapeHtml(i)}</li>`).join('')}
          </${block.ordered ? 'ol' : 'ul'}>
        </td></tr>`

    case 'keyValue':
      return `
        <tr><td style="padding:6px 24px;">
          ${block.title ? `<p style="margin:0 0 8px;font-weight:600;color:${brand.textColor};">${escapeHtml(block.title)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${block.rows
              .filter((row) => row.value.trim())
              .map(
                (row) =>
                  `<tr><td style="padding:4px 12px 4px 0;font-size:14px;color:${brand.mutedColor};white-space:nowrap;">${escapeHtml(row.label)}</td><td style="padding:4px 0;font-size:14px;color:${brand.textColor};">${escapeHtml(row.value)}</td></tr>`,
              )
              .join('')}
          </table>
        </td></tr>`

    case 'columns':
      // Stacked rather than side by side: Outlook does not do grid, and a
      // single column is what a phone shows anyway.
      return block.columns
        .map(
          (column) => `
        <tr><td style="padding:10px 24px;">
          ${column.heading ? `<p style="margin:0 0 4px;font-family:${brand.headingFont};font-size:16px;color:${brand.primaryColor};">${escapeHtml(column.heading)}</p>` : ''}
          ${paragraphs(column.body).map((p) => `<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:${brand.textColor};">${escapeHtml(p)}</p>`).join('')}
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
              ? `background:${brand.primaryColor};color:#ffffff;`
              : `border:2px solid ${brand.primaryColor};color:${brand.primaryColor};`
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
          <a href="${escapeHtml(url)}" style="display:inline-block;padding:24px 32px;border-radius:6px;background:#f1f5f9;color:${brand.primaryColor};font-weight:600;text-decoration:none;">
            ${escapeHtml(block.caption || 'Watch the video')}
          </a>
        </td></tr>`
    }

    case 'qrCode':
      // A QR code in an email is pointless — the reader is already on a device
      // that can follow a link. Dropped rather than shipped as a blank box.
      return ''

    case 'divider':
      return `<tr><td style="padding:12px 24px;"><hr style="border:0;border-top:1px solid #e2e8f0;margin:0;" /></td></tr>`

    case 'spacer':
      return `<tr><td style="height:${block.heightPt}px;line-height:${block.heightPt}px;">&nbsp;</td></tr>`

    case 'clause':
      return `
        <tr><td style="padding:6px 24px;">
          ${block.title ? `<p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${brand.textColor};">${escapeHtml(block.title)}</p>` : ''}
          ${paragraphs(block.body).map((p) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${brand.mutedColor};">${escapeHtml(p)}</p>`).join('')}
        </td></tr>`

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
}): string {
  const brand = input.brand ?? DEFAULT_EMAIL_BRAND
  const track = input.trackLink ?? NO_TRACKING
  const body = input.blocks.map((block) => blockHtml(block, brand, track)).join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>&nbsp;</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:${brand.bodyFont};">
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
        ${input.footer ? `<p style="margin:0 0 8px;font-size:12px;color:${brand.mutedColor};">${escapeHtml(input.footer)}</p>` : ''}
        <p style="margin:0;font-size:12px;color:${brand.mutedColor};">
          <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${brand.mutedColor};text-decoration:underline;">Unsubscribe from these emails</a>
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
}): string {
  const lines: string[] = []
  const track = input.trackLink ?? NO_TRACKING

  for (const block of input.blocks) {
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
