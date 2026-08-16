import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { brandKits, proposalItems, proposalVersions } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal, sendProposal } from '@/modules/crm/proposals'
import { createDocumentForProposal, saveDocument } from '@/modules/design/documents'
import { renderDocumentPdf, type RenderInput } from '@/modules/pdf/layout'
import { PageCanvas, parseColor, truncateToWidth, wrapText } from '@/modules/pdf/writer'
import { toWinAnsi, widthOf } from '@/modules/pdf/metrics'
import {
  latestSentPdf,
  proposalVersionHistory,
  renderProposalPreview,
} from '@/modules/pdf/service'
import { renderInvoicePdf } from '@/modules/pdf/invoice'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { readDocument, usesOf } from '@/modules/evidence/service'
import { digestOf } from '@/modules/evidence/store'
import type { Block } from '@/modules/design/blocks'

/**
 * Server-side PDF generation and immutable snapshots (spec §7, §18, Phase 21).
 *
 * Two claims under test:
 *
 *   **The same input produces the same bytes.** Everything else rests on it —
 *   an immutability claim proved by a digest is worthless if the renderer is
 *   free to produce a different file each time.
 *
 *   **What the client was sent never changes.** Send a proposal, then move the
 *   brand kit, the wording and the prices underneath it; the file the client
 *   downloads is the one they were sent.
 */

const AT = new Date('2026-03-01T09:30:00Z')
const LATER = new Date('2026-09-14T17:02:11Z')

const BRAND = {
  primaryColor: '#0d6e60',
  accentColor: '#0f766e',
  textColor: '#0f172a',
  mutedColor: '#64748b',
  headingFont: 'Georgia, serif',
  bodyFont: 'system-ui, sans-serif',
  baseSizePt: 11,
}

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    blocks: [
      {
        id: 'a',
        type: 'heading',
        text: 'Scope of work',
        level: 2,
        align: 'left',
      },
      {
        id: 'b',
        type: 'text',
        text: 'Tear off and replace the north wing roof covering.',
        align: 'left',
        emphasis: false,
      },
    ] as Block[],
    brand: BRAND,
    merge: {},
    pageSize: 'letter',
    orientation: 'portrait',
    headerText: null,
    footerText: null,
    showPageNumbers: false,
    title: 'Test document',
    author: 'Test Co',
    createdAt: AT,
    ...overrides,
  }
}

/** Parses the xref table and checks every offset lands on its object. */
function xrefIsSound(pdf: Buffer): boolean {
  const text = pdf.toString('latin1')
  const start = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split(/\s/)[0])
  const rows = text.slice(start).split('\n')
  const count = Number(rows[1].split(/\s+/)[1])

  for (let index = 1; index < count; index += 1) {
    const row = rows[1 + index + 1]
    if (!row?.endsWith('n ')) continue

    const offset = Number(row.split(/\s+/)[0])
    if (!new RegExp(`^${index} 0 obj`).test(text.slice(offset, offset + 24))) return false
  }

  return true
}

describe('the writer', () => {
  it('produces a structurally valid file', () => {
    const pdf = renderDocumentPdf(input())

    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4')
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true)
    expect(xrefIsSound(pdf)).toBe(true)
  })

  it('renders the same bytes every time', () => {
    // The claim everything else in this phase rests on. A browser cannot make
    // it: Chromium stamps its own version and a wall-clock date into the file.
    expect(renderDocumentPdf(input())).toEqual(renderDocumentPdf(input()))
    expect(digestOf(renderDocumentPdf(input()))).toBe(digestOf(renderDocumentPdf(input())))
  })

  it('changes the bytes when anything visible changes', () => {
    const base = digestOf(renderDocumentPdf(input()))

    expect(digestOf(renderDocumentPdf(input({ createdAt: LATER })))).not.toBe(base)
    expect(digestOf(renderDocumentPdf(input({ title: 'Something else' })))).not.toBe(base)
    // `textColor` rather than `primaryColor`: this document is a heading and a
    // paragraph, and neither draws in the primary colour. A test that changed
    // a token the document does not use would pass for the wrong reason.
    expect(
      digestOf(renderDocumentPdf(input({ brand: { ...BRAND, textColor: '#aa0000' } }))),
    ).not.toBe(base)
    expect(
      digestOf(renderDocumentPdf(input({ brand: { ...BRAND, baseSizePt: 13 } }))),
    ).not.toBe(base)
  })

  it('escapes the characters that would corrupt a content stream', () => {
    const pdf = renderDocumentPdf(
      input({
        blocks: [
          {
            id: 'a',
            type: 'text',
            text: 'Parentheses ( ) and a backslash \\ and a newline',
            align: 'left',
            emphasis: false,
          },
        ] as Block[],
      }),
    )

    expect(xrefIsSound(pdf)).toBe(true)
    const body = pdf.toString('latin1')
    expect(body).toContain('\\(')
    expect(body).toContain('\\)')
  })

  it('writes real typographic glyphs rather than folding them to ASCII', () => {
    // `--` in a client-facing title is a visible defect, and WinAnsiEncoding
    // has the actual characters.
    expect(toWinAnsi('a — b')).toBe('a \x97 b')
    expect(toWinAnsi('“quoted”')).toBe('\x93quoted\x94')
    expect(toWinAnsi('one… two')).toBe('one\x85 two')

    // Control characters would break the stream, so they go.
    expect(toWinAnsi('line\nbreak')).toBe('linebreak')
    expect(toWinAnsi('tab\there')).toBe('tab    here')

    // And a character with no glyph is visibly wrong rather than invisibly
    // missing.
    expect(toWinAnsi('漢字')).toBe('??')
  })

  it('measures the standard fonts, including the typographic extras', () => {
    expect(widthOf('iii', 'Helvetica', 10)).toBeLessThan(widthOf('MMM', 'Helvetica', 10))
    // Courier is monospaced, which is why it has no table.
    expect(widthOf('iii', 'Courier', 10)).toBe(widthOf('MMM', 'Courier', 10))
    // An em dash is a full em, so it is wider than a hyphen.
    expect(widthOf(toWinAnsi('—'), 'Helvetica', 10)).toBeGreaterThan(
      widthOf('-', 'Helvetica', 10),
    )
    expect(widthOf('', 'Helvetica', 10)).toBe(0)
  })

  it('wraps to a width, and leaves an over-long word alone', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', {
      font: 'Helvetica',
      size: 11,
      maxWidth: 80,
    })

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      // Every line fits, except one that is a single word.
      if (line.includes(' ')) expect(widthOf(line, 'Helvetica', 11)).toBeLessThanOrEqual(80)
    }

    // A URL is placed alone and allowed to overflow rather than being chopped
    // mid-character, which would make it un-clickable and un-typeable.
    const url = 'https://example.test/a/very/long/path/that/will/not/fit/anywhere'
    expect(wrapText(url, { font: 'Helvetica', size: 11, maxWidth: 50 })).toEqual([url])

    // Blank lines survive, because they are the paragraph breaks somebody typed.
    expect(wrapText('a\n\nb', { font: 'Helvetica', size: 11, maxWidth: 500 })).toEqual([
      'a',
      '',
      'b',
    ])
  })

  it('truncates to a width with an ellipsis', () => {
    const long = 'An extremely long description that will not fit in the column'
    const cut = truncateToWidth(long, { font: 'Helvetica', size: 10, maxWidth: 100 })

    expect(cut.endsWith('...')).toBe(true)
    expect(widthOf(cut, 'Helvetica', 10)).toBeLessThanOrEqual(100)
    // Something that already fits is returned untouched.
    expect(truncateToWidth('short', { font: 'Helvetica', size: 10, maxWidth: 100 })).toBe('short')
  })

  it('parses colours and falls back rather than throwing', () => {
    expect(parseColor('#ffffff')).toEqual({ r: 1, g: 1, b: 1 })
    expect(parseColor('#000000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseColor('not a colour', { r: 0.5, g: 0.5, b: 0.5 })).toEqual({
      r: 0.5,
      g: 0.5,
      b: 0.5,
    })
  })

  it('draws nothing for a zero-sized rectangle', () => {
    const page = new PageCanvas(612, 792)
    page.rect({ x: 0, y: 0, width: 0, height: 10, color: { r: 0, g: 0, b: 0 } })
    page.text('', { x: 0, y: 0, font: 'Helvetica', size: 10 })

    expect(page.content()).toBe('')
  })

  it('numbers pages only when asked, and counts them correctly', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `t${index}`,
      type: 'text',
      text: `Paragraph number ${index} with enough words in it to occupy a line or two of the page.`,
      align: 'left',
      emphasis: false,
    })) as Block[]

    const numbered = renderDocumentPdf(
      input({ blocks: many, showPageNumbers: true, footerText: 'Test Co' }),
    ).toString('latin1')

    expect(numbered).toContain('(1 of ')
    expect(numbered).toContain('(2 of ')

    // Matched as a whole drawn string, not a substring: the body text of this
    // document contains "of the page", which a looser assertion would catch.
    const plain = renderDocumentPdf(input({ blocks: many })).toString('latin1')
    expect(/\(\d+ of \d+\) Tj/.test(plain)).toBe(false)
    expect(/\(\d+ of \d+\) Tj/.test(numbered)).toBe(true)
  })

  it('starts a new page at a page break, and not twice in a row', () => {
    const pageCount = (pdf: Buffer) =>
      Number(/\/Type \/Pages \/Count (\d+)/.exec(pdf.toString('latin1'))?.[1])

    const one = renderDocumentPdf(
      input({ blocks: [{ id: 'a', type: 'text', text: 'Only this.', align: 'left', emphasis: false }] as Block[] }),
    )
    expect(pageCount(one)).toBe(1)

    const broken = renderDocumentPdf(
      input({
        blocks: [
          { id: 'a', type: 'text', text: 'Before.', align: 'left', emphasis: false },
          { id: 'b', type: 'pageBreak' },
          { id: 'c', type: 'text', text: 'After.', align: 'left', emphasis: false },
        ] as Block[],
      }),
    )
    expect(pageCount(broken)).toBe(2)

    // Two breaks in a row must not leave a blank sheet in the middle.
    const doubled = renderDocumentPdf(
      input({
        blocks: [
          { id: 'a', type: 'text', text: 'Before.', align: 'left', emphasis: false },
          { id: 'b', type: 'pageBreak' },
          { id: 'c', type: 'pageBreak' },
          { id: 'd', type: 'text', text: 'After.', align: 'left', emphasis: false },
        ] as Block[],
      }),
    )
    expect(pageCount(doubled)).toBe(2)
  })

  it('renders every block type without falling over', () => {
    const all: Block[] = [
      { id: '1', type: 'cover', title: 'Cover', subtitle: 'Sub', preparedFor: 'For', showLogo: true, useBrandBackground: true },
      { id: '2', type: 'heading', text: 'Heading', level: 1, align: 'center' },
      { id: '3', type: 'text', text: 'Body.', align: 'right', emphasis: true },
      { id: '4', type: 'list', items: ['one', 'two'], ordered: true },
      { id: '5', type: 'keyValue', title: 'Facts', rows: [{ label: 'A', value: 'B' }] },
      { id: '6', type: 'pricingTable', title: 'Fees', showQuantity: true, showUnitPrice: true, allowOptionalSelection: true, showTotals: true },
      { id: '7', type: 'image', assetId: null, caption: 'A picture', widthPercent: 100, align: 'left' },
      { id: '8', type: 'divider' },
      { id: '9', type: 'spacer', heightPt: 24 },
      { id: '10', type: 'columns', columns: [{ heading: 'X', body: 'x' }, { heading: 'Y', body: 'y' }] },
      { id: '11', type: 'clause', clauseVersionId: null, title: 'Terms', body: 'Legal wording.' },
      { id: '12', type: 'signature', prompt: 'Accept', agreementText: 'I agree.' },
      { id: '13', type: 'button', label: 'Go', url: 'https://example.test', style: 'solid', align: 'center' },
      { id: '14', type: 'qrCode', value: 'https://example.test', caption: 'Scan', sizePt: 96, align: 'right' },
      { id: '15', type: 'video', url: 'https://example.test/v', thumbnailAssetId: null, caption: 'Watch', widthPercent: 100 },
    ]

    const pdf = renderDocumentPdf(
      input({
        blocks: all,
        lines: [
          { description: 'Included work', quantityMilli: 2000, unitPriceCents: 50_000, amountCents: 100_000, isOptional: false, isSelected: true },
          { description: 'Optional extra', quantityMilli: 1000, unitPriceCents: 25_000, amountCents: 25_000, isOptional: true, isSelected: false },
        ],
        totals: { subtotalCents: 100_000, discountCents: 5_000, taxCents: 7_600, totalCents: 102_600 },
      }),
    )

    expect(xrefIsSound(pdf)).toBe(true)
    const body = pdf.toString('latin1')
    // The figures on the page come from the caller, so they cannot drift from
    // the record.
    expect(body).toContain('$1,000.00')
    expect(body).toContain('$1,026.00')
    // An unselected optional item is shown and priced at nothing, rather than
    // hidden: the client was offered it and chose not to take it.
    expect(body).toContain('not selected')
  })

  it('resolves merge fields, and leaves nothing behind for an unknown one', () => {
    const pdf = renderDocumentPdf(
      input({
        blocks: [
          { id: 'a', type: 'text', text: 'For {{client.name}} of {{client.city}}.', align: 'left', emphasis: false },
        ] as Block[],
        merge: { 'client.name': 'Kestrel Joinery' },
      }),
    ).toString('latin1')

    expect(pdf).toContain('Kestrel Joinery')
    expect(pdf).not.toContain('{{')
  })
})

describe('a sent proposal never changes', () => {
  async function sendable() {
    const fixture = await createCompanyFixture({ name: 'Snapshot Co' })
    const organization = await createOrganization(fixture.ctx, { name: 'Harborview' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Roof package',
      expectedValueCents: 2_000_000,
    })
    const revenue = await fixture.account('4000')

    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Roof proposal',
      items: [
        { description: 'Tear-off and replace', unitPriceCents: 1_800_000, chartAccountId: revenue.id },
      ],
    })

    const document = await createDocumentForProposal(fixture.ctx, proposal.id, 'simple-estimate')
    await saveDocument(fixture.ctx, document.id, {
      blocks: [
        { id: 'a', type: 'cover', title: 'Roof package', subtitle: 'PRO-1', preparedFor: '{{client.name}}', showLogo: true, useBrandBackground: true },
        { id: 'b', type: 'text', text: 'The original wording.', align: 'left', emphasis: false },
        { id: 'c', type: 'pricingTable', title: 'Investment', showQuantity: true, showUnitPrice: true, allowOptionalSelection: true, showTotals: true },
      ] as Block[],
    })

    return { fixture, proposal, document }
  }

  it('files the rendered PDF against the version, in the send transaction', async () => {
    const { fixture, proposal } = await sendable()

    const sent = await sendProposal(fixture.ctx, proposal.id)
    expect(sent.pdfDocumentId).not.toBeNull()

    const [version] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposal.id))

    expect(version.pdfDocumentId).toBe(sent.pdfDocumentId)

    const stored = await readDocument(fixture.companyId, sent.pdfDocumentId as string)
    expect(stored?.data.subarray(0, 8).toString()).toBe('%PDF-1.4')
    expect(stored?.document.contentType).toBe('application/pdf')
  })

  it('keeps the bytes when the brand, the wording and the prices all move', async () => {
    const { fixture, proposal, document } = await sendable()

    const sent = await sendProposal(fixture.ctx, proposal.id)
    const original = await readDocument(fixture.companyId, sent.pdfDocumentId as string)
    const digest = digestOf(original?.data as Buffer)

    // Everything the renderer reads, changed.
    await db
      .update(brandKits)
      .set({ primaryColor: '#aa0000', headingFont: 'Courier, monospace', baseSizePt: 14 })
      .where(eq(brandKits.companyId, fixture.companyId))

    await saveDocument(fixture.ctx, document.id, {
      blocks: [
        { id: 'b', type: 'text', text: 'Completely different wording.', align: 'left', emphasis: false },
      ] as Block[],
    })

    await db
      .update(proposalItems)
      .set({ unitPriceCents: 9_999_900, amountCents: 9_999_900 })
      .where(eq(proposalItems.proposalId, proposal.id))

    // The claim.
    const after = await readDocument(fixture.companyId, sent.pdfDocumentId as string)
    expect(digestOf(after?.data as Buffer)).toBe(digest)
    expect(after?.data).toEqual(original?.data)

    // And a live preview *does* move, which is what makes the first assertion
    // mean something rather than being true of a renderer that ignores input.
    const preview = await renderProposalPreview(fixture.ctx, proposal.id, new Date('2026-04-01'))
    expect(digestOf(preview)).not.toBe(digest)
    expect(preview.toString('latin1')).toContain('Completely different wording')
  })

  it('keeps each version separately, and the public link serves the newest', async () => {
    const { fixture, proposal, document } = await sendable()

    const first = await sendProposal(fixture.ctx, proposal.id)

    await saveDocument(fixture.ctx, document.id, {
      blocks: [
        { id: 'b', type: 'text', text: 'Revised after the site visit.', align: 'left', emphasis: false },
      ] as Block[],
    })

    const second = await sendProposal(fixture.ctx, proposal.id)

    expect(second.versionNumber).toBe(2)
    expect(second.pdfDocumentId).not.toBe(first.pdfDocumentId)

    const history = await proposalVersionHistory(fixture.ctx, proposal.id)
    expect(history).toHaveLength(2)
    expect(history.every((version) => version.pdfDocumentId)).toBe(true)

    // Version one still says what it said.
    const one = await readDocument(fixture.companyId, first.pdfDocumentId as string)
    expect(one?.data.toString('latin1')).toContain('The original wording')

    const latest = await latestSentPdf(fixture.companyId, proposal.id)
    expect(latest?.versionNumber).toBe(2)
    expect(latest?.documentId).toBe(second.pdfDocumentId)
  })

  it('sends a proposal that has no document, and says there is no PDF', async () => {
    const fixture = await createCompanyFixture({ name: 'No Doc Co' })
    const organization = await createOrganization(fixture.ctx, { name: 'Plainsong' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Bare',
      expectedValueCents: 100_000,
    })
    const revenue = await fixture.account('4000')

    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'No document',
      items: [{ description: 'Work', unitPriceCents: 100_000, chartAccountId: revenue.id }],
    })

    // The record of what was sent matters more than the rendering of it, so
    // the send succeeds and the version simply carries no PDF.
    const sent = await sendProposal(fixture.ctx, proposal.id)
    expect(sent.pdfDocumentId).toBeNull()
    expect(await latestSentPdf(fixture.companyId, proposal.id)).toBeNull()
  })

  it('does not leak one company’s snapshot to another', async () => {
    const { fixture, proposal } = await sendable()
    const other = await createCompanyFixture({ name: 'Nosy Co' })

    const sent = await sendProposal(fixture.ctx, proposal.id)

    expect(await readDocument(other.companyId, sent.pdfDocumentId as string)).toBeNull()
    expect(await latestSentPdf(other.companyId, proposal.id)).toBeNull()
  })

  it('stores one copy when two sends render identical bytes', async () => {
    const { fixture, proposal } = await sendable()

    // The clock is pinned rather than raced. `sendProposal` stamps the file
    // with `new Date()`, and the PDF's timestamp has one-second resolution, so
    // the property under test — identical input, identical bytes — held only
    // when both sends happened to land inside the same second. That is a
    // coincidence the suite was relying on, and on a loaded machine it is a
    // coincidence that stops happening.
    //
    // Only `Date` is faked: the driver's own timers have to keep running or
    // the connection pool stalls.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-05-04T09:00:00Z') })

    let first: Awaited<ReturnType<typeof sendProposal>>
    let second: Awaited<ReturnType<typeof sendProposal>>
    try {
      first = await sendProposal(fixture.ctx, proposal.id)
      second = await sendProposal(fixture.ctx, proposal.id)
    } finally {
      vi.useRealTimers()
    }

    expect(second.versionNumber).toBe(2)

    // Nothing changed between the two sends, so the renderer produced the same
    // bytes, and Phase 20's content addressing stored them once and handed back
    // the same document to both versions.
    //
    // Two rows in `proposal_versions`, one row in `documents`, one blob. That
    // is the two phases composing rather than merely coexisting.
    expect(second.pdfDocumentId).toBe(first.pdfDocumentId)

    const links = await usesOf(fixture.ctx, first.pdfDocumentId as string)
    expect(links).toHaveLength(2)
    expect(links.every((link) => link.subjectType === 'proposal_version')).toBe(true)

    const history = await proposalVersionHistory(fixture.ctx, proposal.id)
    expect(history.map((version) => version.pdfDocumentId)).toEqual([
      first.pdfDocumentId,
      first.pdfDocumentId,
    ])
  })
})

describe('invoices', () => {
  it('renders from the record, with the figures the ledger holds', async () => {
    const fixture = await createCompanyFixture({ name: 'Invoice PDF Co' })
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Holdings' })
    const revenue = await fixture.account('4000')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          description: 'Consulting, March',
          quantityMilli: 12_000,
          unitPriceCents: 15_000,
          chartAccountId: revenue.id,
        },
      ],
    })

    const { bytes, filename } = await renderInvoicePdf(fixture.ctx, invoice.id, AT)

    expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4')
    expect(xrefIsSound(bytes)).toBe(true)
    expect(filename).toContain(invoice.number)

    const body = bytes.toString('latin1')
    expect(body).toContain('Harborview Holdings')
    expect(body).toContain('$1,800.00')
    expect(body).toContain('Consulting, March')
  })

  it('refuses another company’s invoice', async () => {
    const ours = await createCompanyFixture({ name: 'Ours PDF Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs PDF Co' })

    const customer = await createCustomer(theirs.ctx, { name: 'Their Client' })
    const revenue = await theirs.account('4000')
    const invoice = await createInvoice(theirs.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ description: 'Work', unitPriceCents: 10_000, chartAccountId: revenue.id }],
    })

    await expect(renderInvoicePdf(ours.ctx, invoice.id, AT)).rejects.toThrow(/does not exist/i)
  })
})
