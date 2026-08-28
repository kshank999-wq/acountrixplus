import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bills, customers, invoices, vendors } from '@/db/schema'
import { DomainError } from '@/modules/errors'
import { updateCustomer, updateVendor } from '@/modules/receivables/service'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { deactivationCheck } from './changes'

/**
 * The people a business trades with (spec §6, §13).
 *
 * Customers and vendors existed from Phase 2 as a dropdown inside the invoice
 * composer and nothing else — no page listing them, no way to reach one, and
 * no way to change one once created. This is the module that makes them
 * records somebody owns rather than rows somebody accidentally created.
 */

export type PartySummary = {
  id: string
  name: string
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  paymentTermsDays: number
  notes: string | null
  isActive: boolean
  /** Documents still open. What stops them being retired. */
  openDocuments: number
  /** What they owe, or what is owed to them. */
  balanceCents: number
  /** Every document ever, so a quiet record is distinguishable from a new one. */
  documentCount: number
}

export type VendorSummary = PartySummary & {
  taxId: string | null
  is1099Vendor: boolean
}

/** The states a document is in while it is still somebody's business. */
const OPEN_STATUSES = ['open', 'partial'] as const

/**
 * Every customer, with enough about their trading to decide anything.
 *
 * The counts are joined rather than fetched per row. A list screen that runs
 * two queries per customer is one that stops loading at four hundred of them,
 * which is a size a real business reaches in a year.
 */
export async function listCustomerSummaries(ctx: ActorContext): Promise<PartySummary[]> {
  requirePermission(ctx, 'crm:view')

  const trading = db
    .select({
      customerId: invoices.customerId,
      openDocuments: sql<string>`count(*) filter (where ${inArray(invoices.status, [...OPEN_STATUSES])})`.as(
        'open_documents',
      ),
      balanceCents: sql<string>`coalesce(sum(${invoices.balanceCents}), 0)`.as('balance_cents'),
      documentCount: sql<string>`count(*)`.as('document_count'),
    })
    .from(invoices)
    .where(eq(invoices.companyId, ctx.companyId))
    .groupBy(invoices.customerId)
    .as('trading')

  const rows = await db
    .select({
      customer: customers,
      openDocuments: trading.openDocuments,
      balanceCents: trading.balanceCents,
      documentCount: trading.documentCount,
    })
    .from(customers)
    .leftJoin(trading, eq(trading.customerId, customers.id))
    .where(scoped(ctx, customers))
    .orderBy(sql`lower(${customers.name})`)

  return rows.map((row) => ({
    id: row.customer.id,
    name: row.customer.name,
    email: row.customer.email,
    phone: row.customer.phone,
    addressLine1: row.customer.addressLine1,
    addressLine2: row.customer.addressLine2,
    city: row.customer.city,
    region: row.customer.region,
    postalCode: row.customer.postalCode,
    paymentTermsDays: row.customer.paymentTermsDays,
    notes: row.customer.notes,
    isActive: row.customer.isActive,
    openDocuments: Number(row.openDocuments ?? 0),
    balanceCents: Number(row.balanceCents ?? 0),
    documentCount: Number(row.documentCount ?? 0),
  }))
}

export async function listVendorSummaries(ctx: ActorContext): Promise<VendorSummary[]> {
  requirePermission(ctx, 'accounting:view')

  const trading = db
    .select({
      vendorId: bills.vendorId,
      openDocuments: sql<string>`count(*) filter (where ${inArray(bills.status, [...OPEN_STATUSES])})`.as(
        'open_documents',
      ),
      balanceCents: sql<string>`coalesce(sum(${bills.balanceCents}), 0)`.as('balance_cents'),
      documentCount: sql<string>`count(*)`.as('document_count'),
    })
    .from(bills)
    .where(eq(bills.companyId, ctx.companyId))
    .groupBy(bills.vendorId)
    .as('trading')

  const rows = await db
    .select({
      vendor: vendors,
      openDocuments: trading.openDocuments,
      balanceCents: trading.balanceCents,
      documentCount: trading.documentCount,
    })
    .from(vendors)
    .leftJoin(trading, eq(trading.vendorId, vendors.id))
    .where(scoped(ctx, vendors))
    .orderBy(sql`lower(${vendors.name})`)

  return rows.map((row) => ({
    id: row.vendor.id,
    name: row.vendor.name,
    email: row.vendor.email,
    phone: row.vendor.phone,
    addressLine1: row.vendor.addressLine1,
    addressLine2: row.vendor.addressLine2,
    city: row.vendor.city,
    region: row.vendor.region,
    postalCode: row.vendor.postalCode,
    paymentTermsDays: row.vendor.paymentTermsDays,
    notes: row.vendor.notes,
    isActive: row.vendor.isActive,
    taxId: row.vendor.taxId,
    is1099Vendor: row.vendor.is1099Vendor,
    openDocuments: Number(row.openDocuments ?? 0),
    balanceCents: Number(row.balanceCents ?? 0),
    documentCount: Number(row.documentCount ?? 0),
  }))
}

/** One customer, for a screen that is about to change them. */
export async function customerById(ctx: ActorContext, customerId: string) {
  requirePermission(ctx, 'crm:view')

  const [row] = await db
    .select()
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, customerId)))
    .limit(1)

  if (!row) throw new DomainError('That customer is not on these books.')
  return row
}

/** One vendor. */
export async function vendorById(ctx: ActorContext, vendorId: string) {
  requirePermission(ctx, 'accounting:view')

  const [row] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, vendorId)))
    .limit(1)

  if (!row) throw new DomainError('That vendor is not on these books.')
  return row
}

/**
 * Retires a customer, or says what is in the way.
 *
 * An **archive**, not a delete. Every document ever raised still names them,
 * the aging report is unchanged, and nothing about the books moves. What it
 * stops is their appearing in a picker, which is the actual thing somebody
 * means by "we do not work with them any more".
 *
 * Refused while there is open business, and not for tidiness: a customer
 * hidden from every picker while still owing money is a debt nobody will
 * chase. The books stay right and the business quietly stops collecting.
 */
export async function setCustomerActive(
  ctx: ActorContext,
  customerId: string,
  isActive: boolean,
): Promise<{ name: string; isActive: boolean }> {
  requirePermission(ctx, 'crm:manage')

  if (!isActive) {
    const [position] = await db
      .select({
        openDocuments: sql<string>`count(*) filter (where ${inArray(invoices.status, [...OPEN_STATUSES])})`,
        balanceCents: sql<string>`coalesce(sum(${invoices.balanceCents}), 0)`,
      })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, customerId)))

    const verdict = deactivationCheck({
      openDocuments: Number(position?.openDocuments ?? 0),
      balanceCents: Number(position?.balanceCents ?? 0),
    })

    if (!verdict.ok) throw new DomainError(verdict.message)
  }

  const updated = await updateCustomer(ctx, customerId, { isActive })
  return { name: updated.name, isActive: updated.isActive }
}

/** Retires a vendor. See `setCustomerActive` — the reasoning is the same. */
export async function setVendorActive(
  ctx: ActorContext,
  vendorId: string,
  isActive: boolean,
): Promise<{ name: string; isActive: boolean }> {
  requirePermission(ctx, 'accounting:journal')

  if (!isActive) {
    const [position] = await db
      .select({
        openDocuments: sql<string>`count(*) filter (where ${inArray(bills.status, [...OPEN_STATUSES])})`,
        balanceCents: sql<string>`coalesce(sum(${bills.balanceCents}), 0)`,
      })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, vendorId)))

    const verdict = deactivationCheck({
      openDocuments: Number(position?.openDocuments ?? 0),
      balanceCents: Number(position?.balanceCents ?? 0),
    })

    if (!verdict.ok) throw new DomainError(verdict.message)
  }

  const updated = await updateVendor(ctx, vendorId, { isActive })
  return { name: updated.name, isActive: updated.isActive }
}
