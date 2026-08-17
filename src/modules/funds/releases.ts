import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  fundReleases,
  funds,
  journalEntries,
  journalLineDimensions,
  journalLines,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { createJournalEntry } from '@/modules/ledger/journal'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { monthEnd, monthStart } from '@/modules/assets/depreciation'
import { FundError, fundAccounts, fundDimensionId } from './service'
import { isReleasable, releaseFor, type Restriction } from './restriction'

/**
 * Releasing restriction as money is spent (spec §5, "funds/restrictions").
 *
 * ## What a release is
 *
 * A donor gives £10,000 for the roof. The charity spends £4,000 on the roof.
 * At that moment £4,000 of the restriction has been satisfied — the donor's
 * condition was met — and the money moves from the restricted column of the
 * statement of activities to the unrestricted one.
 *
 * It is the same money. **A release changes no total.** The debit and the
 * credit are both revenue accounts and they sum to zero, so a charity's total
 * income for the year is identical whether or not the release has been run.
 * What changes is which column it sits in, and that is the only thing a
 * restricted-funds report is about.
 *
 * ## Why the run reads the ledger rather than this module's own records
 *
 * Spending is not recorded here. A bill coded to the roof appeal by a
 * bookkeeper who has never opened the funds screen is spending against the
 * roof appeal, and a run that only counted expenditure booked through its own
 * API would silently under-release exactly the charities with the most staff.
 *
 * So the run queries `journal_line_dimensions` for expense lines carrying the
 * fund's dimension value — the same rows Phase 16's dimensional profit and
 * loss reads. Phase 23 proved the equivalent claim for property repairs; this
 * is the same trick and the same test.
 *
 * ## Running twice
 *
 * `unique(fund_id, period_start)` on `fund_releases`. Two people pressing the
 * button in the same second produce one release because the database refuses
 * the second, which is the rule this application has applied since Phase 19:
 * where two people can act at once, the database arbitrates.
 */

export type ReleaseLine = {
  fundId: string
  fundCode: string
  fundName: string
  periodStart: string
  spentCents: number
  releasedCents: number
  shortfallCents: number
  journalEntryId: string | null
  /** Why nothing was posted, when nothing was. */
  skipped: 'already_released' | 'nothing_spent' | 'nothing_to_release' | null
}

export type ReleaseRun = {
  periodStart: string
  periodEnd: string
  lines: ReleaseLine[]
  releasedCents: number
  shortfallCents: number
  postedCount: number
}

/**
 * What each restricted fund received on or before a date.
 *
 * Read off the ledger rather than off `contributions`, because a charity that
 * imported last year's books (Phase 17) or posted an opening balance by hand
 * has restricted money this module never saw recorded. Revenue credited to a
 * fund is money given to that fund, whoever typed it.
 *
 * Signed as a credit balance: revenue accounts are credit-normal, and the
 * release pair is excluded because a release is not a receipt — counting it
 * would let a fund release the same money twice.
 */
async function receivedByFund(
  ctx: ActorContext,
  dimensionId: string,
  fundIds: string[],
  through: string,
  exec: Executor,
): Promise<Map<string, number>> {
  if (fundIds.length === 0) return new Map()

  const rows = await exec
    .select({
      fundId: funds.id,
      cents: sql<string>`sum(${journalLines.creditCents} - ${journalLines.debitCents})`,
    })
    .from(journalLines)
    .innerJoin(
      journalLineDimensions,
      and(
        eq(journalLineDimensions.journalLineId, journalLines.id),
        eq(journalLineDimensions.dimensionId, dimensionId),
      ),
    )
    .innerJoin(funds, eq(funds.dimensionValueId, journalLineDimensions.dimensionValueId))
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        lt(journalEntries.entryDate, through),
        inArray(funds.id, fundIds),
        inArray(chartAccounts.type, ['revenue', 'other_income']),
        // The release pair nets to zero across the two columns, so including
        // it would leave the arithmetic right and the meaning wrong: a fund
        // whose restriction was released would look as though it had been
        // given the money a second time.
        sql`${chartAccounts.number} NOT IN (${INDUSTRY_ACCOUNTS.releasedFromRestriction}, ${INDUSTRY_ACCOUNTS.releasedToUnrestricted})`,
      ),
    )
    .groupBy(funds.id)

  return new Map(rows.map((row) => [row.fundId, Number(row.cents ?? 0)]))
}

/**
 * What each fund has already had released — ever, not up to a date.
 *
 * Deliberately unfiltered by period, and this is load-bearing. Months can be
 * run out of order: somebody runs March, then notices February was never run.
 * Counting only the releases dated before February would make February blind to
 * March's, and a fund given £1,000 that spent £1,000 in each month would
 * release £2,000 — money it was never given, which is the one thing this module
 * exists to prevent.
 *
 * The cost is that a late February release, run after March, sees the money as
 * already gone and posts a shortfall instead. That is the safe direction: the
 * total released stays capped at the total given, and the shortfall says
 * plainly that February's spending was covered by something other than
 * February's restricted money.
 */
async function releasedByFund(
  ctx: ActorContext,
  fundIds: string[],
  exec: Executor,
): Promise<Map<string, number>> {
  if (fundIds.length === 0) return new Map()

  const rows = await exec
    .select({
      fundId: fundReleases.fundId,
      cents: sql<string>`sum(${fundReleases.releasedCents})`,
    })
    .from(fundReleases)
    .where(scoped(ctx, fundReleases, inArray(fundReleases.fundId, fundIds)))
    .groupBy(fundReleases.fundId)

  return new Map(rows.map((row) => [row.fundId, Number(row.cents ?? 0)]))
}

/**
 * What each fund was spent on in a window.
 *
 * Expense, COGS and other-expense lines carrying the fund's dimension value,
 * net of credits so that a refunded or reclassified cost reduces the spend
 * rather than being ignored.
 */
export async function spentByFund(
  ctx: ActorContext,
  dimensionId: string,
  fundIds: string[],
  from: string,
  toExclusive: string,
  exec: Executor = db,
): Promise<Map<string, number>> {
  if (fundIds.length === 0) return new Map()

  const rows = await exec
    .select({
      fundId: funds.id,
      cents: sql<string>`sum(${journalLines.debitCents} - ${journalLines.creditCents})`,
    })
    .from(journalLines)
    .innerJoin(
      journalLineDimensions,
      and(
        eq(journalLineDimensions.journalLineId, journalLines.id),
        eq(journalLineDimensions.dimensionId, dimensionId),
      ),
    )
    .innerJoin(funds, eq(funds.dimensionValueId, journalLineDimensions.dimensionValueId))
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        gte(journalEntries.entryDate, from),
        lt(journalEntries.entryDate, toExclusive),
        inArray(funds.id, fundIds),
        inArray(chartAccounts.type, ['expense', 'cogs', 'other_expense']),
      ),
    )
    .groupBy(funds.id)

  return new Map(rows.map((row) => [row.fundId, Number(row.cents ?? 0)]))
}

/** The day after the last day of a month, as an exclusive upper bound. */
function nextMonthStart(periodStart: string): string {
  const end = monthEnd(periodStart)
  const next = new Date(`${end}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * Works out what a month's release would be, without posting anything.
 *
 * `month` is a parameter and never a clock read — the same rule Phase 16
 * applied to depreciation, Phase 21 to the PDF timestamp, Phase 23 to the rent
 * run and Phase 24 to retention. A run that read the clock could not be asked
 * what it would have released last March, and could not be asserted on at all.
 */
export async function previewReleases(
  ctx: ActorContext,
  input: { month: string },
): Promise<ReleaseRun> {
  requirePermission(ctx, 'accounting:view')

  const periodStart = monthStart(input.month)
  const periodEnd = monthEnd(periodStart)
  const nextStart = nextMonthStart(periodStart)

  const dimensionId = await fundDimensionId(ctx)
  if (!dimensionId) {
    return {
      periodStart,
      periodEnd,
      lines: [],
      releasedCents: 0,
      shortfallCents: 0,
      postedCount: 0,
    }
  }

  const restricted = await db
    .select({
      id: funds.id,
      code: funds.code,
      name: funds.name,
      restriction: funds.restriction,
    })
    .from(funds)
    .where(scoped(ctx, funds, eq(funds.isActive, true)))
    .orderBy(asc(funds.code))

  // An endowment's principal is never releasable, so it is filtered here
  // rather than reported as a fund with nothing to release. See `isReleasable`.
  const eligible = restricted.filter((fund) => isReleasable(fund.restriction as Restriction))
  const ids = eligible.map((fund) => fund.id)

  const [received, alreadyReleased, spent, existing] = await Promise.all([
    // Everything given up to the *end* of this period, so a gift received in
    // the same month it was spent counts — which is how an emergency appeal
    // actually behaves.
    receivedByFund(ctx, dimensionId, ids, nextStart, db),
    releasedByFund(ctx, ids, db),
    spentByFund(ctx, dimensionId, ids, periodStart, nextStart, db),
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({ fundId: fundReleases.fundId })
          .from(fundReleases)
          .where(
            scoped(
              ctx,
              fundReleases,
              and(inArray(fundReleases.fundId, ids), eq(fundReleases.periodStart, periodStart)),
            ),
          ),
  ])

  const done = new Set(existing.map((row) => row.fundId))

  const lines: ReleaseLine[] = eligible.map((fund) => {
    const spentCents = Math.max(0, spent.get(fund.id) ?? 0)

    // Released so far is subtracted, because it has already left the fund.
    // Without it, a fund given £10,000 and spending £4,000 a month would
    // release £4,000 every month for ever.
    const availableCents =
      (received.get(fund.id) ?? 0) - (alreadyReleased.get(fund.id) ?? 0)

    const { releaseCents, shortfallCents } = releaseFor(availableCents, spentCents)

    const skipped: ReleaseLine['skipped'] = done.has(fund.id)
      ? 'already_released'
      : spentCents === 0
        ? 'nothing_spent'
        : releaseCents === 0
          ? 'nothing_to_release'
          : null

    return {
      fundId: fund.id,
      fundCode: fund.code,
      fundName: fund.name,
      periodStart,
      spentCents,
      releasedCents: skipped === 'already_released' ? 0 : releaseCents,
      shortfallCents: skipped === 'already_released' ? 0 : shortfallCents,
      journalEntryId: null,
      skipped,
    }
  })

  return {
    periodStart,
    periodEnd,
    lines,
    releasedCents: lines.reduce((sum, line) => sum + line.releasedCents, 0),
    shortfallCents: lines.reduce((sum, line) => sum + line.shortfallCents, 0),
    postedCount: 0,
  }
}

/**
 * Posts one month's releases.
 *
 * One entry per fund rather than one for the whole month, so that a fund's
 * release can be found, read and — if it was wrong — reversed on its own. A
 * single combined entry would make correcting one appeal a matter of unpicking
 * every other appeal's line from the same entry.
 *
 * A fund with a shortfall still gets its release posted for what it *could*
 * cover. The shortfall is recorded beside it rather than blocking it: the money
 * really was spent, the restriction really was partly satisfied, and refusing
 * to post would leave the books wrong in order to protest about a decision
 * somebody had already taken.
 */
export async function runReleases(
  ctx: ActorContext,
  input: { month: string },
): Promise<ReleaseRun> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'funds')

  const preview = await previewReleases(ctx, input)
  const accounts = await fundAccounts(ctx)

  const fromRestricted = accounts.need(
    INDUSTRY_ACCOUNTS.releasedFromRestriction,
    'a Net Assets Released from Restriction account',
  )
  const toUnrestricted = accounts.need(
    INDUSTRY_ACCOUNTS.releasedToUnrestricted,
    'a Net Assets Released — Unrestricted account',
  )

  const dimensionId = await fundDimensionId(ctx)
  if (!dimensionId) return preview

  const lines: ReleaseLine[] = []
  let posted = 0

  for (const line of preview.lines) {
    if (line.skipped !== null || line.releasedCents <= 0) {
      lines.push(line)
      continue
    }

    const result = await db.transaction(async (tx) => {
      const [fund] = await tx
        .select({ dimensionValueId: funds.dimensionValueId, name: funds.name })
        .from(funds)
        .where(scoped(ctx, funds, eq(funds.id, line.fundId)))
        .limit(1)

      if (!fund) throw new FundError('That fund does not exist.')

      // The claim row goes in first, so that a second run racing this one
      // loses on the unique index before either has posted an entry. The same
      // ordering Phase 23 used for a rent charge, for the same reason: an
      // entry posted before the claim would survive the claim being refused.
      const [claim] = await tx
        .insert(fundReleases)
        .values({
          companyId: ctx.companyId,
          fundId: line.fundId,
          periodStart: line.periodStart,
          spentCents: line.spentCents,
          releasedCents: line.releasedCents,
          shortfallCents: line.shortfallCents,
          releasedBy: ctx.userId,
        })
        .onConflictDoNothing({ target: [fundReleases.fundId, fundReleases.periodStart] })
        .returning({ id: fundReleases.id })

      if (!claim) return null

      const entry = await createJournalEntry(
        ctx,
        {
          entryDate: line.periodStart,
          memo: `Net assets released from restriction — ${fund.name} ${line.periodStart.slice(0, 7)}`,
          source: 'release',
          sourceType: 'fund',
          sourceId: line.fundId,
          lines: [
            {
              chartAccountId: fromRestricted,
              debitCents: line.releasedCents,
              // The debit carries the fund, so the fund's own balance falls.
              dimensions: { [dimensionId]: fund.dimensionValueId },
              memo: 'Restriction satisfied by expenditure',
            },
            {
              chartAccountId: toUnrestricted,
              creditCents: line.releasedCents,
              // The credit deliberately carries no fund. The money is no
              // longer any fund's — that is what being released means, and
              // tagging it back to the appeal would leave the appeal's
              // dimensional balance unchanged by its own release.
              memo: 'Available for general purposes',
            },
          ],
        },
        tx,
      )

      await tx
        .update(fundReleases)
        .set({ journalEntryId: entry.id })
        .where(eq(fundReleases.id, claim.id))

      await recordAudit(
        ctx,
        {
          action: 'fund.release',
          entityType: 'fund',
          entityId: line.fundId,
          after: {
            periodStart: line.periodStart,
            releasedCents: line.releasedCents,
            shortfallCents: line.shortfallCents,
          },
        },
        tx,
      )

      return entry.id
    })

    if (result === null) {
      // Somebody else claimed the period between the preview and the write.
      lines.push({ ...line, releasedCents: 0, shortfallCents: 0, skipped: 'already_released' })
      continue
    }

    posted += 1
    lines.push({ ...line, journalEntryId: result })
  }

  return {
    ...preview,
    lines,
    releasedCents: lines.reduce((sum, line) => sum + line.releasedCents, 0),
    shortfallCents: lines.reduce((sum, line) => sum + line.shortfallCents, 0),
    postedCount: posted,
  }
}

/** Every release posted for a fund, newest first. */
export async function releaseHistory(ctx: ActorContext, fundId?: string) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: fundReleases.id,
      fundId: fundReleases.fundId,
      fundCode: funds.code,
      fundName: funds.name,
      periodStart: fundReleases.periodStart,
      spentCents: fundReleases.spentCents,
      releasedCents: fundReleases.releasedCents,
      shortfallCents: fundReleases.shortfallCents,
      journalEntryId: fundReleases.journalEntryId,
    })
    .from(fundReleases)
    .innerJoin(funds, eq(funds.id, fundReleases.fundId))
    .where(scoped(ctx, fundReleases, fundId ? eq(fundReleases.fundId, fundId) : undefined))
    .orderBy(sql`${fundReleases.periodStart} desc`, asc(funds.code))
}
