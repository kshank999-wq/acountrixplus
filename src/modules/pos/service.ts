import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  journalEntries,
  journalLines,
  posDayCategories,
  posDayTenders,
  posDays,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { createJournalEntry } from '@/modules/ledger/journal'
import { accountByNumber } from '@/modules/coa/service'
import { POS_ACCOUNTS, planImbalanceCents, summariseDay, type DayInput, type DayPlan } from './summary'
import { DomainError } from '@/modules/errors'

/**
 * Importing a day's takings (spec §5, Restaurant and E-commerce).
 *
 * See `summary.ts` for the arithmetic and `db/schema/pos.ts` for why a day is
 * one row with a unique key. This file writes it down and posts it.
 */

export class TakingsError extends DomainError {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'TakingsError'
  }
}

export type PosSource = 'register' | 'marketplace' | 'processor' | 'manual'

/**
 * The accounts a summary posts to, installed if missing.
 *
 * The restaurant and e-commerce packs carry most of them; `6870 Cash Over and
 * Short` is in neither, because until now nothing counted a till. A café on the
 * general pack has none of them, and without this the first import would fail
 * with a message about a chart of accounts the application could have fixed.
 *
 * Only ever adds — the same rule properties, funds and manufacturing follow.
 */
async function ensureAccounts(ctx: ActorContext, exec: Executor): Promise<void> {
  const wanted = [
    {
      number: POS_ACCOUNTS.processorClearing,
      name: 'Payment Processor Clearing',
      type: 'asset' as const,
      subtype: 'undeposited_funds' as const,
    },
    {
      number: POS_ACCOUNTS.tipsPayable,
      name: 'Tips Payable',
      type: 'liability' as const,
      subtype: 'payroll' as const,
    },
    { number: POS_ACCOUNTS.refunds, name: 'Returns and Refunds', type: 'revenue' as const },
    {
      number: POS_ACCOUNTS.processorFees,
      name: 'Marketplace and Platform Fees',
      type: 'expense' as const,
    },
    {
      number: POS_ACCOUNTS.cashOverShort,
      name: 'Cash Over and Short',
      type: 'expense' as const,
      description:
        'Where a counted till and the register disagree. A running balance near zero is a well-run till; a drifting one is a question.',
    },
    {
      number: POS_ACCOUNTS.suspense,
      name: 'POS Import Suspense',
      type: 'asset' as const,
      subtype: 'undeposited_funds' as const,
      description:
        'What a day summary could not explain about itself: its tenders did not equal its sales. Every balance here is a day somebody should go back to.',
    },
  ]

  const existing = await exec
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        inArray(
          chartAccounts.number,
          wanted.map((account) => account.number),
        ),
      ),
    )

  const have = new Set(existing.map((row) => row.number))
  const missing = wanted.filter((account) => !have.has(account.number))
  if (missing.length === 0) return

  await exec
    .insert(chartAccounts)
    .values(missing.map((account) => ({ companyId: ctx.companyId, ...account })))
    .onConflictDoNothing()
}

export type ImportDayInput = {
  businessDate: string
  source?: PosSource
  label?: string | null
  categories: Array<{ name: string; accountNumber: string; amountCents: number }>
  tenders: Array<{ kind: 'cash' | 'card' | 'other'; name: string; amountCents: number; feeCents?: number }>
  taxCents?: number
  tipsCents?: number
  refundsCents?: number
  discountsCents?: number
  countedCashCents?: number | null
  floatCents?: number
  notes?: string | null
}

export type ImportedDay = {
  id: string
  plan: DayPlan
  journalEntryId: string
  /** True when this call is what created it, false when the day already existed. */
  created: boolean
}

/**
 * Imports one day, once.
 *
 * The `pos_days` row goes in **before** the entry and with
 * `onConflictDoNothing` — the same ordering Phase 23 used for a rent charge and
 * Phase 26 for a fund release. An entry posted before the claim would survive
 * the claim being refused, which is how a nightly job that retries doubles a
 * restaurant's revenue.
 *
 * A second call for the same day and source is not an error. It is a retry, and
 * the honest answer is "that day is already in", with the row that is already
 * there.
 */
export async function importDay(
  ctx: ActorContext,
  input: ImportDayInput,
): Promise<ImportedDay> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'pos_import')

  const source: PosSource = input.source ?? 'register'

  if (input.categories.length === 0 && input.tenders.length === 0) {
    throw new TakingsError('A day with no sales and no takings is not a day.')
  }

  const dayInput: DayInput = {
    businessDate: input.businessDate,
    categories: input.categories.map((row) => ({
      accountNumber: row.accountNumber,
      amountCents: row.amountCents,
    })),
    taxCents: input.taxCents ?? 0,
    tipsCents: input.tipsCents ?? 0,
    refundsCents: input.refundsCents ?? 0,
    discountsCents: input.discountsCents ?? 0,
    tenders: input.tenders.map((row) => ({
      kind: row.kind,
      amountCents: row.amountCents,
      feeCents: row.feeCents ?? 0,
    })),
    countedCashCents: input.countedCashCents ?? null,
    floatCents: input.floatCents ?? 0,
  }

  const plan = summariseDay(dayInput)

  // A plan whose own debits and credits disagree cannot be posted, and this is
  // not the same thing as `outOfBalanceCents`. That one says the *source*
  // contradicted itself, which is recorded and named rather than refused. This
  // one can only fire if `summariseDay` has a defect, so it is an assertion
  // about our own code and not a validation of anybody's data.
  const imbalance = planImbalanceCents(plan)
  if (imbalance !== 0) {
    throw new TakingsError(
      `The summary does not balance by ${imbalance} cents. This is a bug in the day summariser, not in your data.`,
    )
  }

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    const [claim] = await tx
      .insert(posDays)
      .values({
        companyId: ctx.companyId,
        businessDate: input.businessDate,
        source: source as never,
        label: input.label?.trim() || null,
        grossSalesCents: plan.grossSalesCents,
        netSalesCents: plan.netSalesCents,
        discountsCents: dayInput.discountsCents,
        refundsCents: dayInput.refundsCents,
        taxCents: plan.taxCents,
        tipsCents: plan.tipsCents,
        feeCents: plan.feeCents,
        takingsCents: plan.takingsCents,
        overShortCents: plan.overShortCents,
        outOfBalanceCents: plan.outOfBalanceCents,
        notes: input.notes?.trim() || null,
        importedBy: ctx.userId,
      })
      .onConflictDoNothing({
        target: [posDays.companyId, posDays.businessDate, posDays.source],
      })
      .returning({ id: posDays.id })

    if (!claim) {
      // Already imported. Hand back what is there rather than raising: a
      // scheduled importer retrying is not an error condition, and treating it
      // as one produces a dead job every night.
      const [existing] = await tx
        .select({ id: posDays.id, journalEntryId: posDays.journalEntryId })
        .from(posDays)
        .where(
          scoped(
            ctx,
            posDays,
            and(
              eq(posDays.businessDate, input.businessDate),
              eq(posDays.source, source as never),
            ),
          ),
        )
        .limit(1)

      return {
        id: existing.id,
        plan,
        journalEntryId: existing.journalEntryId ?? '',
        created: false,
      }
    }

    if (input.categories.length > 0) {
      await tx.insert(posDayCategories).values(
        input.categories.map((row) => ({
          companyId: ctx.companyId,
          posDayId: claim.id,
          name: row.name,
          accountNumber: row.accountNumber,
          amountCents: row.amountCents,
        })),
      )
    }

    if (input.tenders.length > 0) {
      await tx.insert(posDayTenders).values(
        input.tenders.map((row) => ({
          companyId: ctx.companyId,
          posDayId: claim.id,
          kind: row.kind,
          name: row.name,
          amountCents: row.amountCents,
          feeCents: row.feeCents ?? 0,
        })),
      )
    }

    // Resolve every account the plan names, in one query, and refuse the whole
    // import if any is missing — rather than posting most of a day and leaving
    // somebody to work out which category vanished.
    const numbers = [...new Set(plan.lines.map((row) => row.accountNumber))]
    const accounts = await tx
      .select({ id: chartAccounts.id, number: chartAccounts.number })
      .from(chartAccounts)
      .where(scoped(ctx, chartAccounts, inArray(chartAccounts.number, numbers)))

    const byNumber = new Map(accounts.map((row) => [row.number, row.id]))
    const unknown = numbers.filter((number) => !byNumber.has(number))

    if (unknown.length > 0) {
      throw new TakingsError(
        `This chart of accounts has no ${unknown.join(', ')}. Add the account, or point the category at one that exists.`,
      )
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.businessDate,
        memo: `Takings ${input.businessDate}${input.label ? ` — ${input.label}` : ''}`,
        source: 'takings',
        sourceType: 'pos_day',
        sourceId: claim.id,
        lines: plan.lines.map((row) => ({
          chartAccountId: byNumber.get(row.accountNumber) as string,
          debitCents: row.debitCents || undefined,
          creditCents: row.creditCents || undefined,
          memo: row.memo,
        })),
      },
      tx,
    )

    await tx.update(posDays).set({ journalEntryId: entry.id }).where(eq(posDays.id, claim.id))

    await recordAudit(
      ctx,
      {
        action: 'takings.import',
        entityType: 'pos_day',
        entityId: claim.id,
        after: {
          businessDate: input.businessDate,
          source,
          netSalesCents: plan.netSalesCents,
          overShortCents: plan.overShortCents,
        },
      },
      tx,
    )

    return { id: claim.id, plan, journalEntryId: entry.id, created: true }
  })
}

export type TakingsRow = {
  id: string
  businessDate: string
  source: string
  label: string | null
  grossSalesCents: number
  netSalesCents: number
  discountsCents: number
  refundsCents: number
  taxCents: number
  tipsCents: number
  feeCents: number
  takingsCents: number
  overShortCents: number | null
  outOfBalanceCents: number
  journalEntryId: string | null
}

export async function listDays(
  ctx: ActorContext,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<TakingsRow[]> {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: posDays.id,
      businessDate: posDays.businessDate,
      source: posDays.source,
      label: posDays.label,
      grossSalesCents: posDays.grossSalesCents,
      netSalesCents: posDays.netSalesCents,
      discountsCents: posDays.discountsCents,
      refundsCents: posDays.refundsCents,
      taxCents: posDays.taxCents,
      tipsCents: posDays.tipsCents,
      feeCents: posDays.feeCents,
      takingsCents: posDays.takingsCents,
      overShortCents: posDays.overShortCents,
      outOfBalanceCents: posDays.outOfBalanceCents,
      journalEntryId: posDays.journalEntryId,
    })
    .from(posDays)
    .where(
      scoped(
        ctx,
        posDays,
        and(
          opts.from ? gte(posDays.businessDate, opts.from) : undefined,
          opts.to ? lte(posDays.businessDate, opts.to) : undefined,
        ),
      ),
    )
    .orderBy(desc(posDays.businessDate), asc(posDays.source))
    .limit(opts.limit ?? 60)
}

/** What was sold and how it was paid for, on one day. */
export async function dayDetail(ctx: ActorContext, posDayId: string) {
  requirePermission(ctx, 'accounting:view')

  const [categories, tenders] = await Promise.all([
    db
      .select({
        name: posDayCategories.name,
        accountNumber: posDayCategories.accountNumber,
        amountCents: posDayCategories.amountCents,
      })
      .from(posDayCategories)
      .where(scoped(ctx, posDayCategories, eq(posDayCategories.posDayId, posDayId)))
      .orderBy(desc(posDayCategories.amountCents)),
    db
      .select({
        kind: posDayTenders.kind,
        name: posDayTenders.name,
        amountCents: posDayTenders.amountCents,
        feeCents: posDayTenders.feeCents,
      })
      .from(posDayTenders)
      .where(scoped(ctx, posDayTenders, eq(posDayTenders.posDayId, posDayId)))
      .orderBy(desc(posDayTenders.amountCents)),
  ])

  return { categories, tenders }
}

export type TipsPosition = {
  /** What the imported days say was collected for staff. */
  collectedCents: number
  /** What account 2310 actually holds — collected, less what payroll paid out. */
  ledgerCents: number
  /** Collected less what the ledger still owes. Positive means it was paid on. */
  paidOutCents: number
  /** True when nothing has been paid and the two therefore match. */
  agrees: boolean
}

/**
 * What is still owed to staff, against what was collected.
 *
 * The two sides are genuinely different: the left is what the tills reported,
 * the right is the balance on the liability account after payroll has drawn on
 * it. They *should* differ once tips have been paid out, so this does not claim
 * disagreement is a fault — it names the gap, which is the number a manager
 * needs when somebody asks whether last month's tips went out.
 */
export async function tipsPosition(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<TipsPosition> {
  requirePermission(ctx, 'reports:view')

  const [collected] = await db
    .select({ value: sql<string>`coalesce(sum(${posDays.tipsCents}), 0)` })
    .from(posDays)
    .where(
      scoped(ctx, posDays, opts.asOf ? lte(posDays.businessDate, opts.asOf) : undefined),
    )

  const account = await accountByNumber(ctx.companyId, POS_ACCOUNTS.tipsPayable)

  let ledgerCents = 0
  if (account) {
    const [row] = await db
      .select({
        // A liability is credit-normal, so the balance is credits less debits.
        value: sql<string>`coalesce(sum(${journalLines.creditCents} - ${journalLines.debitCents}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.companyId, ctx.companyId),
          eq(journalLines.chartAccountId, account.id),
          eq(journalEntries.status, 'posted'),
          opts.asOf ? lte(journalEntries.entryDate, opts.asOf) : undefined,
        ),
      )

    ledgerCents = Number(row?.value ?? 0)
  }

  const collectedCents = Number(collected?.value ?? 0)

  return {
    collectedCents,
    ledgerCents,
    paidOutCents: collectedCents - ledgerCents,
    agrees: collectedCents === ledgerCents,
  }
}
