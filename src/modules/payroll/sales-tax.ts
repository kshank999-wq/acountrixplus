import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { documentTaxLines, invoices, taxCodes } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { PAYROLL_ACCOUNTS } from './accounts'
import { accountByNumber } from '@/modules/coa/service'
import { taxPerCode } from '@/modules/payroll/tax-rounding'
import { functionalSumSql } from '@/modules/fx/summing'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

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

  /**
   * An exempt code has no rate (Phase 209).
   *
   * `is_exempt` was settable alongside any rate for 208 phases, and nothing
   * reconciled the two: a code marked exempt at 8.75% would have charged 8.75%,
   * because the pricer applies `rate_bp` to whatever base it is given and takes
   * the exempt figure from its caller. The flag was written by one form, printed
   * by one register, and consulted by no arithmetic anywhere — which is why
   * neither census could see it. Nothing in the suite had ever created one.
   *
   * A constraint rather than a check at pricing time (Phase 116). With the rate
   * forced to zero, routing an exempt line's amount into `exempt_cents` is a
   * *reporting* decision — which is what §13 asks for, exempt sales reported
   * beside taxable ones — and not a second answer to what tax was charged.
   */
  if (input.isExempt && input.rateBp !== 0) {
    throw new Refusal(
      'An exempt code has no rate. Set the rate to 0%, or leave the code taxable at ' +
        `${(input.rateBp / 100).toFixed(2)}%.`,
    )
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
 * Retires a code, or brings it back (Phase 210).
 *
 * Phase 209 built the invoice composer's tax-code picker, passed
 * `{ activeOnly: true }` to it, and said in the comment beside the call that
 * the flag was **inert**: `tax_codes.is_active` had no writer, so the filter
 * could only ever drop a row somebody had set false by hand. This is that
 * comment coming out.
 *
 * ## What retiring does not do
 *
 * It does not touch a single invoice. Every `document_tax_lines` row carries
 * the `rate_bp` it was priced at (Phase 2's decision, and ADR 0021's rule for
 * a sent document), so last quarter's return is unaffected by this quarter's
 * list. Retiring is a statement about what may be *offered*, which is exactly
 * the scope of the only flag the picker reads.
 *
 * ## Why `effective_to` is not written here
 *
 * Because the two mean different things and writing both from one control
 * would make them one. A retired code is one a company no longer charges
 * under; a code with an `effective_to` is one superseded by a newer rate for
 * the same jurisdiction from a given day, which needs the *successor* to exist
 * and `priceDocumentTax` to choose between them by date. Nothing does that
 * yet, so `effective_to` keeps no writer and is recorded as a finding rather
 * than given a half meaning.
 */
export async function setTaxCodeActive(
  ctx: ActorContext,
  input: { taxCodeId: string; isActive: boolean },
) {
  requirePermission(ctx, 'tax:manage')

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(taxCodes)
      .where(scoped(ctx, taxCodes, eq(taxCodes.id, input.taxCodeId)))
      .limit(1)

    if (!before) throw missing('taxCode')

    const [code] = await tx
      .update(taxCodes)
      .set({ isActive: input.isActive })
      .where(scoped(ctx, taxCodes, eq(taxCodes.id, input.taxCodeId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'tax_code.update',
        entityType: 'tax_code',
        entityId: code.id,
        before: { isActive: before.isActive },
        after: { code: code.code, isActive: code.isActive },
      },
      tx,
    )

    return code
  })
}

/**
 * The rate applied to one base, rounded half-up.
 *
 * This is the arithmetic and nothing else. It used to carry a sentence about
 * being rounded "once on the total rather than per line" — which is the right
 * rule and was not true of the only caller that mattered: `priceDocumentTax`
 * mapped this over the lines and added the results up for a hundred and forty
 * phases. Phase 145 found it, Phase 151 wired the repair, and the sentence
 * moved with it.
 *
 * The rule now lives where it is enforced. `taxPerCode` rounds a code's
 * combined base once and splits the figure back across its lines, because a
 * document's lines may carry different codes and a return reports per
 * jurisdiction — so "once on the total" cannot mean the document.
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

  for (const line of lines) {
    if (!codes.get(line.taxCodeId)) {
      throw new Refusal('That tax code is not on this company’s list.')
    }
  }

  // Rounded once per code, not once per line (Phase 151, wiring ADR 0145).
  //
  // This mapped `taxOn` over the lines and added the results up, which is the
  // one thing `taxOn`'s own comment says not to do — so an invoice with several
  // lines under one code charged a figure that was not its own printed base
  // times its own printed rate. `taxPerCode` rounds the code's combined base
  // once and splits the result back across the lines it came from, so the lines
  // still sum to the code and the code is what an auditor recomputes.
  const priced = taxPerCode(
    lines.map((line) => ({
      taxCodeId: line.taxCodeId,
      taxableCents: line.taxableCents,
      taxCents: line.taxCents,
    })),
    (taxCodeId) => codes.get(taxCodeId)!.rateBp,
  )

  return {
    totalCents: priced.totalCents,
    // In the order they were given, which `taxPerCode` guarantees — so the
    // exempt figure, which is the caller's and not the rate's, stays on its own
    // line rather than being carried along by the grouping.
    lines: priced.lines.map((row, index) => ({
      taxCodeId: row.taxCodeId,
      taxableCents: row.taxableCents,
      exemptCents: lines[index].exemptCents ?? 0,
      taxCents: row.taxCents,
    })),
  }
}

/**
 * The tax lines a document's own lines imply (Phase 209).
 *
 * ## Why this exists at all
 *
 * `priceDocumentTax` and `recordDocumentTax` have been complete since Phase 2
 * and **nothing in the application had ever supplied them a line.** `taxLines`
 * appeared nowhere under `src/app`; the only writer of `document_tax_lines` was
 * `db/seed.ts`. So a company could create the codes it is registered for, see
 * them listed, and never attach one to anything — while the invoice composer
 * took sales tax as a single typed-in figure that credits 2200 and records no
 * breakdown at all.
 *
 * Which made the return and the ledger disagree by the whole of it, on every
 * invoice the application itself raised. The one place that became visible was
 * the return's own uncoded-sales warning, which blamed the company: *"usually a
 * company that has not set codes up yet; occasionally a real gap."* It was a
 * real gap every time, and not theirs.
 *
 * ## One code per line, not one per document
 *
 * A line is already what carries a job and a cost code, a return is filed per
 * jurisdiction, and `taxPerCode` was built to round a code's *combined* base
 * once and split the figure back across the lines it came from — so several
 * lines sharing one code is the shape this module was written for. A document
 * carrying one code could not have produced the exempt split at all.
 *
 * An exempt code's amount goes to `exemptCents` and never to the base. That is
 * safe to derive here rather than ask for, because `createTaxCode` now refuses
 * an exempt code with a rate: the two fields cannot disagree about what was
 * charged, so which one the amount lands in is purely what the return reports.
 */
export async function taxLinesFor(
  ctx: ActorContext,
  lines: Array<{ amountCents: number; taxCodeId?: string | null }>,
  exec: Executor = db,
): Promise<DocumentTaxLineInput[]> {
  const coded = lines.filter(
    (line): line is { amountCents: number; taxCodeId: string } => !!line.taxCodeId,
  )
  if (coded.length === 0) return []

  const codes = await codesFor(ctx, coded, exec)

  return coded.map((line) => {
    const code = codes.get(line.taxCodeId)
    if (!code) throw new Refusal('That tax code is not on this company’s list.')

    return code.isExempt
      ? { taxCodeId: line.taxCodeId, taxableCents: 0, exemptCents: line.amountCents }
      : { taxCodeId: line.taxCodeId, taxableCents: line.amountCents, exemptCents: 0 }
  })
}

export type QuotedDocumentTax = {
  totalCents: number
  /** One row per code, in the order a return reads them. */
  byCode: Array<{
    code: string
    jurisdiction: string
    rateBp: number
    taxableCents: number
    exemptCents: number
    taxCents: number
  }>
}

/**
 * What the lines being composed will be taxed, before anybody commits to it.
 *
 * A read. It posts nothing and writes nothing, and it exists for the reason
 * `quoteDocument` exists one module over (Phase 64): the arithmetic has to be
 * *the posting's own*. A composer that worked the figure out in the browser
 * would be a second answer to what tax was charged, and it would get it wrong
 * — the rounding is once per code on the code's combined base, not once per
 * line, which is the defect Phase 145 found and Phase 151 repaired here.
 *
 * Grouped per code because that is what a person about to raise the invoice can
 * check against the rate each jurisdiction told them.
 */
export async function quoteDocumentTax(
  ctx: ActorContext,
  lines: Array<{ amountCents: number; taxCodeId?: string | null }>,
): Promise<QuotedDocumentTax> {
  requirePermission(ctx, 'tax:view')

  const taxLines = await taxLinesFor(ctx, lines)
  if (taxLines.length === 0) return { totalCents: 0, byCode: [] }

  const priced = await priceDocumentTax(ctx, taxLines)
  const codes = await codesFor(ctx, taxLines, db)

  const byCode = new Map<string, QuotedDocumentTax['byCode'][number]>()

  for (const line of priced.lines) {
    const code = codes.get(line.taxCodeId)!
    const row = byCode.get(line.taxCodeId) ?? {
      code: code.code,
      jurisdiction: code.jurisdiction,
      rateBp: code.rateBp,
      taxableCents: 0,
      exemptCents: 0,
      taxCents: 0,
    }

    row.taxableCents += line.taxableCents
    row.exemptCents += line.exemptCents
    row.taxCents += line.taxCents
    byCode.set(line.taxCodeId, row)
  }

  return {
    totalCents: priced.totalCents,
    byCode: [...byCode.values()].sort(
      (a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.code.localeCompare(b.code),
    ),
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
      // Each document converted at its own carried rate before it is added
      // (Phase 152). `document_tax_lines` holds face amounts and carries no
      // currency of its own, so a euro invoice and a dollar invoice added to a
      // figure in neither — and this one is filed with a tax authority.
      //
      // Converting each document rather than the total is deliberate: the
      // parts came first here, each already raised and already posted to the
      // ledger at its own rate, which is the distinction ADR 0147 drew between
      // this and the per-line tax rounding Phase 145 repaired.
      taxableCents: functionalSumSql(documentTaxLines.taxableCents, invoices.exchangeRateMillionths),
      exemptCents: functionalSumSql(documentTaxLines.exemptCents, invoices.exchangeRateMillionths),
      taxCents: functionalSumSql(documentTaxLines.taxCents, invoices.exchangeRateMillionths),
    })
    .from(documentTaxLines)
    .innerJoin(taxCodes, eq(taxCodes.id, documentTaxLines.taxCodeId))
    // Left, not inner: a tax line whose invoice has gone should still be
    // reported rather than silently dropped from a return. The join exists for
    // the rate above — without it `exchange_rate_millionths` is null on every
    // row, `functionalSumSql` coalesces null to RATE_ONE, and the sum is face
    // amounts wearing a conversion. `convertedSumStands` is the check that
    // says so.
    .leftJoin(invoices, eq(invoices.id, documentTaxLines.documentId))
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
      // Converted too, for the same reason: this figure is printed beside the
      // taxable sales it is meant to be compared with.
      total: functionalSumSql(invoices.subtotalCents, invoices.exchangeRateMillionths),
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
