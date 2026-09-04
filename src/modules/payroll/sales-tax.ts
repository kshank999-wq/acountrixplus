import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { documentTaxLines, invoices, taxCodes } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { PAYROLL_ACCOUNTS } from './accounts'
import { accountByNumber } from '@/modules/coa/service'
import { Refusal } from '@/modules/errors'

/**
 * Sales tax (spec §13: "sales tax and payroll should use modular/integration
 * architecture due to jurisdictional and compliance complexity").
 *
 * ## Rates are the company's data, not the software's
 *
 * There is no shipped rate table and there will not be one. A rate table in a
 * release is correct on the day it ships and silently wrong afterwards, and
 * "silently wrong but authoritative-looking" is the worst state for a number
 * somebody is about to remit against. A company enters the codes it is
 * registered for, with the rates its jurisdictions told it, and owns them.
 *
 * What this module does own is the arithmetic and the paper trail: which sales
 * were taxable, under which code, at the rate in force when the invoice was
 * raised, and what that adds up to for a return period.
 *
 * ## The rate is frozen onto the line
 *
 * `document_tax_lines.rate_bp` records the rate *as applied*. Changing a code's
 * rate next quarter must not restate last quarter's return, and the only way
 * to guarantee that is to stop reading the rate from the code once the
 * document exists.
 */

export type TaxCodeInput = {
  code: string
  name: string
  jurisdiction: string
  rateBp: number
  isExempt?: boolean
  effectiveFrom?: string
}

export async function createTaxCode(ctx: ActorContext, input: TaxCodeInput) {
  requirePermission(ctx, 'tax:manage')

  if (!input.code.trim()) throw new Refusal('A tax code needs a code.')
  if (!input.jurisdiction.trim()) {
    throw new Refusal('A tax code needs a jurisdiction — it is what the return is filed with.')
  }
  if (input.rateBp < 0 || input.rateBp > 10_000) {
    throw new Refusal('A tax rate must be between 0% and 100%.')
  }

  const liability = await accountByNumber(ctx.companyId, PAYROLL_ACCOUNTS.salesTaxPayable)

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(taxCodes)
      .values({
        companyId: ctx.companyId,
        code: input.code.trim(),
        name: input.name.trim(),
        jurisdiction: input.jurisdiction.trim(),
        rateBp: input.rateBp,
        isExempt: input.isExempt ?? false,
        liabilityAccountId: liability?.id ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'tax_code.create',
        entityType: 'tax_code',
        entityId: created.id,
        after: {
          code: created.code,
          jurisdiction: created.jurisdiction,
          rateBp: created.rateBp,
        },
      },
      tx,
    )

    return created
  })
}

export async function listTaxCodes(ctx: ActorContext, opts: { activeOnly?: boolean } = {}) {
  requirePermission(ctx, 'tax:view')

  const rows = await db
    .select()
    .from(taxCodes)
    .where(scoped(ctx, taxCodes))
    .orderBy(asc(taxCodes.jurisdiction), asc(taxCodes.code))

  return opts.activeOnly ? rows.filter((row) => row.isActive) : rows
}

/**
 * Computes tax for a set of taxable amounts under one code.
 *
 * Pure, and rounded **once on the total** rather than per line. Rounding each
 * line and adding them up drifts by up to half a cent per line, and a return
 * that does not foot against the invoices behind it is a return somebody has
 * to reconcile by hand.
 */
export function taxOn(taxableCents: number, rateBp: number): number {
  return Math.round((taxableCents * rateBp) / 10_000)
}

/**
 * Loads the codes a set of lines refers to.
 *
 * `inArray`, never a raw interpolated list. Building an id list into SQL by
 * hand is the exact shape of the injection advisory this project upgraded
 * drizzle to escape, and a tax code id arrives from a request body.
 */
async function codesFor(
  ctx: ActorContext,
  lines: Array<{ taxCodeId: string }>,
  exec: Executor,
) {
  const rows = await exec
    .select()
    .from(taxCodes)
    .where(
      and(
        eq(taxCodes.companyId, ctx.companyId),
        inArray(
          taxCodes.id,
          lines.map((line) => line.taxCodeId),
        ),
      ),
    )

  return new Map(rows.map((row) => [row.id, row]))
}

export type DocumentTaxLineInput = {
  taxCodeId: string
  taxableCents: number
  exemptCents?: number
  /** Optional override; otherwise computed from the code's current rate. */
  taxCents?: number
}

export type PricedDocumentTax = {
  totalCents: number
  lines: Array<Required<Pick<DocumentTaxLineInput, 'taxCodeId' | 'taxableCents' | 'exemptCents' | 'taxCents'>>>
}

/**
 * Prices a set of tax lines without writing anything.
 *
 * `createInvoice` needs the tax total *before* it opens its transaction, since
 * the total is part of the invoice it is about to write — but the breakdown
 * can only be recorded once that invoice has an id. Pricing here and passing
 * the priced lines through means the two are computed once, from one read of
 * the codes, and cannot drift apart between the header and the detail.
 */
export async function priceDocumentTax(
  ctx: ActorContext,
  lines: DocumentTaxLineInput[],
  exec: Executor = db,
): Promise<PricedDocumentTax> {
  if (lines.length === 0) return { totalCents: 0, lines: [] }

  const codes = await codesFor(ctx, lines, exec)

  const priced = lines.map((line) => {
    const code = codes.get(line.taxCodeId)
    if (!code) throw new Refusal('That tax code is not on this company’s list.')

    return {
      taxCodeId: line.taxCodeId,
      taxableCents: line.taxableCents,
      exemptCents: line.exemptCents ?? 0,
      taxCents: line.taxCents ?? taxOn(line.taxableCents, code.rateBp),
    }
  })

  return {
    totalCents: priced.reduce((sum, line) => sum + line.taxCents, 0),
    lines: priced,
  }
}

/**
 * Records what a document's tax was made of.
 *
 * Called alongside `createInvoice`, inside its transaction. The invoice's own
 * `taxCents` stays the authority on the total — this records the breakdown so
 * a return can report per jurisdiction, which a single lump figure cannot be
 * split into afterwards.
 */
export async function recordDocumentTax(
  ctx: ActorContext,
  input: {
    documentType: 'invoice' | 'bill'
    documentId: string
    documentDate: string
    lines: Array<{
      taxCodeId: string
      taxableCents: number
      exemptCents?: number
      /** Optional override; otherwise computed from the code's current rate. */
      taxCents?: number
    }>
  },
  exec: Executor = db,
): Promise<number> {
  if (input.lines.length === 0) return 0

  const byId = await codesFor(ctx, input.lines, exec)

  let total = 0
  const rows = input.lines.map((line) => {
    const code = byId.get(line.taxCodeId)
    if (!code) throw new Refusal('That tax code is not on this company’s list.')

    const taxCents = line.taxCents ?? taxOn(line.taxableCents, code.rateBp)
    total += taxCents

    return {
      companyId: ctx.companyId,
      documentType: input.documentType,
      documentId: input.documentId,
      documentDate: input.documentDate,
      taxCodeId: line.taxCodeId,
      taxableCents: line.taxableCents,
      exemptCents: line.exemptCents ?? 0,
      taxCents,
      // Frozen: a later rate change must not restate this document.
      rateBp: code.rateBp,
    }
  })

  await exec.insert(documentTaxLines).values(rows)
  return total
}

export type JurisdictionReturnLine = {
  taxCodeId: string
  code: string
  name: string
  jurisdiction: string
  rateBp: number
  grossSalesCents: number
  taxableCents: number
  exemptCents: number
  taxCollectedCents: number
}

export type SalesTaxReturn = {
  periodStart: string
  periodEnd: string
  lines: JurisdictionReturnLine[]
  totalTaxableCents: number
  totalExemptCents: number
  totalTaxCollectedCents: number
  /** What the ledger says is in Sales Tax Payable at period end. */
  ledgerBalanceCents: number
  /**
   * Collected in the period minus what the ledger holds. Non-zero is not
   * necessarily wrong — an earlier period may be unremitted — but it is the
   * number an accountant checks first, so it is computed rather than left for
   * them to work out.
   */
  varianceCents: number
  /** True when some sales carry no tax code at all. */
  hasUncodedSales: boolean
  uncodedSalesCents: number
}

/**
 * The figures for a sales tax return.
 *
 * Two things about the shape are deliberate. Exempt sales are reported
 * alongside taxable ones, because most returns ask for both and a system that
 * only tracked what it charged tax on cannot answer the second question. And
 * the ledger balance is shown next to the period's collections rather than
 * instead of them — they answer different questions, and quietly presenting
 * one as the other is how a return gets filed for the wrong amount.
 */
export async function salesTaxReturn(
  ctx: ActorContext,
  range: { periodStart: string; periodEnd: string },
): Promise<SalesTaxReturn> {
  requirePermission(ctx, 'tax:view')

  const rows = await db
    .select({
      taxCodeId: documentTaxLines.taxCodeId,
      code: taxCodes.code,
      name: taxCodes.name,
      jurisdiction: taxCodes.jurisdiction,
      rateBp: documentTaxLines.rateBp,
      taxableCents: sql<string>`coalesce(sum(${documentTaxLines.taxableCents}), 0)`,
      exemptCents: sql<string>`coalesce(sum(${documentTaxLines.exemptCents}), 0)`,
      taxCents: sql<string>`coalesce(sum(${documentTaxLines.taxCents}), 0)`,
    })
    .from(documentTaxLines)
    .innerJoin(taxCodes, eq(taxCodes.id, documentTaxLines.taxCodeId))
    .where(
      scoped(
        ctx,
        documentTaxLines,
        eq(documentTaxLines.documentType, 'invoice'),
        gte(documentTaxLines.documentDate, range.periodStart),
        lte(documentTaxLines.documentDate, range.periodEnd),
      ),
    )
    .groupBy(
      documentTaxLines.taxCodeId,
      taxCodes.code,
      taxCodes.name,
      taxCodes.jurisdiction,
      documentTaxLines.rateBp,
    )
    .orderBy(asc(taxCodes.jurisdiction), asc(taxCodes.code))

  const lines: JurisdictionReturnLine[] = rows.map((row) => ({
    taxCodeId: row.taxCodeId,
    code: row.code,
    name: row.name,
    jurisdiction: row.jurisdiction,
    rateBp: row.rateBp,
    taxableCents: Number(row.taxableCents),
    exemptCents: Number(row.exemptCents),
    taxCollectedCents: Number(row.taxCents),
    grossSalesCents: Number(row.taxableCents) + Number(row.exemptCents),
  }))

  const totalTaxableCents = lines.reduce((sum, line) => sum + line.taxableCents, 0)
  const totalExemptCents = lines.reduce((sum, line) => sum + line.exemptCents, 0)
  const totalTaxCollectedCents = lines.reduce((sum, line) => sum + line.taxCollectedCents, 0)

  // Invoiced sales in the period that carry no tax breakdown at all. Usually a
  // company that has not set tax codes up yet; occasionally a real gap.
  const [uncoded] = await db
    .select({
      total: sql<string>`coalesce(sum(${invoices.subtotalCents}), 0)`,
    })
    .from(invoices)
    .where(
      scoped(
        ctx,
        invoices,
        gte(invoices.issueDate, range.periodStart),
        lte(invoices.issueDate, range.periodEnd),
        sql`${invoices.status} <> 'void'`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${documentTaxLines}
          WHERE ${documentTaxLines.documentId} = ${invoices.id}
            AND ${documentTaxLines.documentType} = 'invoice'
        )`,
      ),
    )

  const ledgerBalanceCents = await salesTaxLedgerBalance(ctx, range.periodEnd)

  return {
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    lines,
    totalTaxableCents,
    totalExemptCents,
    totalTaxCollectedCents,
    ledgerBalanceCents,
    varianceCents: totalTaxCollectedCents - ledgerBalanceCents,
    hasUncodedSales: Number(uncoded?.total ?? 0) > 0,
    uncodedSalesCents: Number(uncoded?.total ?? 0),
  }
}

/** Sales Tax Payable at a date, straight from posted journal lines. */
async function salesTaxLedgerBalance(ctx: ActorContext, asOfDate: string): Promise<number> {
  const account = await accountByNumber(ctx.companyId, PAYROLL_ACCOUNTS.salesTaxPayable)
  if (!account) return 0

  const { journalEntries, journalLines } = await import('@/db/schema')

  const [row] = await db
    .select({
      credits: sql<string>`coalesce(sum(${journalLines.creditCents}), 0)`,
      debits: sql<string>`coalesce(sum(${journalLines.debitCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      scoped(
        ctx,
        journalLines,
        eq(journalLines.chartAccountId, account.id),
        eq(journalEntries.status, 'posted'),
        lte(journalEntries.entryDate, asOfDate),
      ),
    )

  return Number(row?.credits ?? 0) - Number(row?.debits ?? 0)
}
