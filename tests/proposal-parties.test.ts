import { describe, expect, it } from 'vitest'
import { buildMergeContext } from '@/modules/design/merge-fields'
import { letterheadFor } from '@/modules/brand/letterhead'
import { PageCanvas, writePdf } from '@/modules/pdf/writer'
import { renderDocumentPdf, type BrandTokens } from '@/modules/pdf/layout'
import type { Block } from '@/modules/design/blocks'

/**
 * The document that becomes a contract (Phase 76).
 *
 * Pure — `renderDocumentPdf` takes everything it needs as an argument. No
 * database, no clock.
 */

const BRAND: BrandTokens = {
  primaryColor: '#0d6e60',
  accentColor: '#0f766e',
  textColor: '#0f172a',
  mutedColor: '#64748b',
  headingFont: 'Georgia, serif',
  bodyFont: 'system-ui, sans-serif',
  baseSizePt: 11,
}

const SIGNATURE: Block = {
  id: 'sig',
  type: 'signature',
  prompt: 'Accept this proposal',
  agreementText: 'By signing below I accept this proposal on behalf of {{client.name}}.',
}

const PROFILE = {
  legalName: 'Ridgeline Construction LLC',
  addressLine1: '412 Mill Street',
  addressLine2: 'Suite 300',
  city: 'Bellingham',
  region: 'WA',
  postalCode: '98225',
}

/** The document's text as a reader sees it — `(` and `)` are escaped in a PDF. */
function readable(bytes: Buffer): string {
  return bytes.toString('latin1').replace(/\\([()\\])/g, '$1')
}

function render(merge: Record<string, string>): string {
  return readable(
    renderDocumentPdf({
      blocks: [SIGNATURE],
      brand: BRAND,
      merge,
      pageSize: 'letter',
      orientation: 'portrait',
      headerText: null,
      footerText: null,
      showPageNumbers: false,
      lines: [],
      totals: { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 },
      title: 'P-1001 Depot Road',
      author: 'Ridgeline Construction LLC',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }),
  )
}

describe('the signature block names both parties', () => {
  const context = buildMergeContext({
    company: letterheadFor({ companyName: 'Ridgeline Construction', profile: PROFILE }),
    client: { name: 'Harborview Holdings' },
  })

  /**
   * This block is where a proposal stops being a document and becomes a
   * contract. It named the client — "on behalf of Harborview Holdings" — and
   * never the side that would be bound by it.
   */
  it('names the party making the offer, with its address', () => {
    const body = render(context)

    expect(body).toContain('Harborview Holdings')
    expect(body).toContain('Offered by Ridgeline Construction LLC')
    expect(body).toContain('412 Mill Street')
    expect(body).toContain('Suite 300')
    expect(body).toContain('Bellingham, WA 98225')
  })

  /**
   * It reads the merge context rather than a new block field, so it reaches
   * proposals composed before this phase — the ones whose authors cannot go
   * back and add it.
   */
  it('needs nothing added to the block to appear', () => {
    expect(Object.keys(SIGNATURE)).toEqual(['id', 'type', 'prompt', 'agreementText'])
  })

  /** A marketing creative has no company party, and must not grow an empty heading. */
  it('draws as it always did when there is no company in the context', () => {
    const body = render({ 'client.name': 'Harborview Holdings' })

    expect(body).not.toContain('Offered by')
    expect(body).toContain('Signature')
  })

  it('names the company even when it has no address at all', () => {
    const bare = buildMergeContext({
      company: letterheadFor({ companyName: 'Bare Co' }),
      client: { name: 'Harborview Holdings' },
    })

    expect(render(bare)).toContain('Offered by Bare Co')
  })
})

/**
 * One postal address, however many documents (Phase 76).
 *
 * `merge-fields` had its own `formatAddress`, which silently dropped
 * `addressLine2` and `country`. So `{{company.address}}` on a proposal and the
 * letterhead on that same company's invoice disagreed about where the business
 * is.
 */
describe('one address formatter', () => {
  it('gives the proposal the address the invoice letterhead prints', () => {
    const head = letterheadFor({
      companyName: 'Ridgeline Construction',
      profile: { ...PROFILE, country: 'United States' },
    })
    const context = buildMergeContext({ company: head })

    expect(context['company.address']).toBe(head.address.join('\n'))
    expect(context['company.address']).toContain('Suite 300')
    expect(context['company.address']).toContain('United States')
  })

  it('lays a client’s address out the same way', () => {
    const context = buildMergeContext({
      client: {
        name: 'Harborview Holdings',
        addressLine1: 'Unit 4',
        addressLine2: 'Kiln Yard',
        city: 'Bellingham',
        region: 'WA',
        postalCode: '98226',
      },
    })

    expect(context['client.address']).toBe('Unit 4\nKiln Yard\nBellingham, WA 98226')
  })

  it('omits an address nobody gave rather than writing an empty one', () => {
    const context = buildMergeContext({ client: { name: 'Harborview Holdings' } })
    expect(context['client.address']).toBeUndefined()
  })
})

describe('the company fields the designer can insert', () => {
  const context = buildMergeContext({
    company: letterheadFor({ companyName: 'Ridgeline Construction', profile: PROFILE }),
  })

  /**
   * `company.legalName` used to be `profile.legalName ?? company.name` — a
   * second, differently-derived answer to the question `company.name` already
   * answers. Both now come off the letterhead.
   */
  it('does not offer two different answers for the company’s name', () => {
    expect(context['company.name']).toBe('Ridgeline Construction LLC')
    expect(context['company.legalName']).toBe(context['company.name'])
  })

  it('offers the trading name the letterhead kept', () => {
    expect(context['company.tradingName']).toBe('Ridgeline Construction')
  })

  /** `writePdf` is untouched by any of this — the bytes still start as they did. */
  it('leaves the writer alone', () => {
    const pdf = writePdf({
      title: 'x',
      author: 'y',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      pages: [new PageCanvas(612, 792)],
    })
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4')
  })
})
