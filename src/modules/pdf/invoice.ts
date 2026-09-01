import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies, companyProfiles, customers, invoiceLines, invoices } from '@/db/schema'
import { contactLines, letterheadFor } from '@/modules/brand/letterhead'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import { renderDocumentPdf, type BrandTokens } from './layout'
import type { Block } from '@/modules/design/blocks'
import { DomainError } from '@/modules/errors'

/**
 * An invoice as a PDF (spec §13, §18).
 *
 * Built out of the same block model the proposal designer uses rather than a
 * second layout engine. An invoice is a cover line, a few key/value rows, a
 * priced table and some payment wording — which is a document this application
 * already knows how to lay out. Writing a bespoke invoice renderer would mean
 * two things to fix every time the page-break logic is wrong.
 *
 * Unlike a proposal, an invoice is **not** snapshotted. It is regenerated from
 * the record every time, because an invoice is not a negotiating position: if
 * it was wrong it gets credited and reissued, and the ledger — not a PDF — is
 * the authority for what is owed. Snapshotting one would create a second
 * answer to "how much does this customer owe", which ADR 0002 spent a whole
 * phase refusing.
 */

/**
 * An invoice is drawn in the default kit rather than the company's.
 *
 * Not an oversight and not a copy: the brand kit is the *proposal* document's,
 * chosen in the Design Center for the things a company sends to win work. A
 * demand for payment is a different register. It reads the same constant as
 * everything else since Phase 79, where it used to be a third hand-written
 * copy of it under a different name.
 */
const INVOICE_BRAND: BrandTokens = DEFAULT_BRAND_KIT

export class NoInvoiceError extends DomainError {
  readonly status = 404
  constructor() {
    super('That invoice does not exist.')
    this.name = 'NoInvoiceError'
  }
}

export async function renderInvoicePdf(
  ctx: ActorContext,
  invoiceId: string,
  at: Date,
): Promise<{ bytes: Buffer; filename: string }> {
  requirePermission(ctx, 'accounting:view')

  const [row] = await db
    .select({
      invoice: invoices,
      customer: customers,
      company: companies,
      profile: companyProfiles,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(companies, eq(companies.id, invoices.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, invoices.companyId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, ctx.companyId)))
    .limit(1)

  if (!row) throw new NoInvoiceError()

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.sortOrder))

  const address = [
    row.customer.name,
    row.customer.addressLine1,
    [row.customer.city, row.customer.region, row.customer.postalCode].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join('\n')

  // Who is billing, from the profile they filled in (Phase 75). Until now this
  // document carried the company's name and nothing else — no address, no
  // telephone number, no email — on the one thing this application produces
  // that a stranger receives and has to pay against.
  const head = letterheadFor({ companyName: row.company.name, profile: row.profile })
  // Everything below the name, which the cover band already carries.
  const identity = [
    ...(head.tradingName ? [`trading as ${head.tradingName}`] : []),
    ...head.address,
    ...contactLines(head),
  ]

  const blocks: Block[] = [
    {
      id: 'cover',
      type: 'cover',
      title: 'Invoice',
      subtitle: row.invoice.number,
      preparedFor: head.name,
      showLogo: false,
      useBrandBackground: true,
    },
    ...(identity.length > 0
      ? ([
          {
            id: 'letterhead',
            type: 'text',
            // One line each. `wrapText` breaks on newlines before it wraps, so
            // an address reads down the page the way an envelope does.
            text: identity.join('\n'),
            align: 'left',
            emphasis: false,
          },
        ] satisfies Block[])
      : []),
    {
      id: 'details',
      type: 'keyValue',
      title: '',
      rows: [
        { label: 'Billed to', value: address.replace(/\n/g, ', ') },
        { label: 'Issued', value: row.invoice.issueDate },
        { label: 'Due', value: row.invoice.dueDate },
        ...(row.invoice.memo ? [{ label: 'Reference', value: row.invoice.memo }] : []),
      ],
    },
    { id: 'table', type: 'pricingTable', title: '', showQuantity: true, showUnitPrice: true, allowOptionalSelection: false, showTotals: true },
  ]

  if (row.profile?.paymentInstructions) {
    blocks.push(
      { id: 'pay-heading', type: 'heading', text: 'How to pay', level: 3, align: 'left' },
      { id: 'pay', type: 'text', text: row.profile.paymentInstructions, align: 'left', emphasis: false },
    )
  }

  const bytes = renderDocumentPdf({
    blocks,
    brand: INVOICE_BRAND,
    merge: {},
    pageSize: 'letter',
    orientation: 'portrait',
    headerText: null,
    // What they chose to say at the foot of a document — a licence number, a
    // registration, whatever their trade requires. It has existed since Phase 4
    // and, until now, reached only the footer of a marketing email.
    footerText: head.footer ?? head.name,
    showPageNumbers: true,
    lines: lines.map((line) => ({
      description: line.description,
      quantityMilli: line.quantityMilli,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
      isOptional: false,
      isSelected: true,
    })),
    totals: {
      subtotalCents: row.invoice.subtotalCents,
      discountCents: 0,
      taxCents: row.invoice.taxCents,
      totalCents: row.invoice.totalCents,
    },
    title: `Invoice ${row.invoice.number}`,
    author: head.name,
    createdAt: at,
  })

  return { bytes, filename: `invoice-${row.invoice.number}.pdf` }
}
