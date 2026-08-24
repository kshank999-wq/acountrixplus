import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  depreciationEntries,
  fixedAssets,
  journalEntries,
  journalLines,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry } from '@/modules/ledger/journal'
import type { DimensionAssignment } from '@/modules/dimensions/service'
import {
  depreciationSchedule,
  disposalOutcome,
  monthStart,
  periodsThrough,
  type DepreciationConvention,
  type DepreciationMethod,
  type SchedulePeriod,
} from './depreciation'
import { DomainError } from '@/modules/errors'

/**
 * The fixed asset register (spec §13).
 *
 * ## The claim: the register equals the ledger
 *
 * The sum of the register's costs is the Fixed Assets account. The sum of its
 * depreciation is Accumulated Depreciation. `reconcileFixedAssets` proves both
 * and `tests/assets.test.ts` asserts them — the same identity inventory has
 * carried since ADR 0014, for the same reason: a subledger that can disagree
 * with the ledger is a second set of books.
 *
 * The asymmetry worth noticing is that the ledger is the authority and the
 * register is the explanation. When they disagree the ledger is not wrong —
 * something was bought and coded to Fixed Assets that nobody wrote down, or
 * somebody wrote down an asset the company never actually paid for. Both are
 * findings, and neither is fixed by adjusting the register to match.
 */

export class AssetError extends DomainError {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'AssetError'
  }
}

/** Raised when a concurrent run claimed the same period first. */
export class DepreciationRaceError extends DomainError {
  readonly status = 409
  constructor(
    readonly expected: number,
    readonly claimed: number,
  ) {
    super(
      `Depreciation for ${expected} ${expected === 1 ? 'asset' : 'assets'} was expected but only ` +
        `${claimed} could be claimed — another run posted the rest. Nothing was posted twice.`,
    )
    this.name = 'DepreciationRaceError'
  }
}

export type RegisterAssetInput = {
  name: string
  description?: string | null
  category?: string | null
  serialNumber?: string | null
  location?: string | null
  costCents: number
  salvageValueCents?: number
  lifeMonths: number
  method?: DepreciationMethod
  convention?: DepreciationConvention
  /** Basis points: 20000 is double-declining. Ignored for straight line. */
  decliningFactorBp?: number
  acquiredDate: string
  inServiceDate?: string
  assetAccountId?: string
  accumulatedAccountId?: string
  expenseAccountId?: string
  vendorId?: string | null
  projectId?: string | null
  sourceType?: string | null
  sourceId?: string | null
  notes?: string | null
  /**
   * Set only when the purchase is **not** already in the books — an asset
   * contributed by an owner, or a historic one being entered during setup.
   * Posts `Dr Fixed Assets / Cr <this account>`.
   *
   * Left unset for the normal case, where a supplier bill already coded the
   * cost to Fixed Assets and posting it again would put the truck on the
   * balance sheet twice.
   */
  postAcquisitionCreditAccountId?: string
}

export type FixedAsset = {
  id: string
  tag: string
  name: string
  category: string | null
  costCents: number
  salvageValueCents: number
  lifeMonths: number
  method: DepreciationMethod
  convention: DepreciationConvention
  decliningFactorBp: number
  acquiredDate: string
  inServiceDate: string
  status: 'active' | 'fully_depreciated' | 'disposed'
  accumulatedCents: number
  bookValueCents: number
  disposedOn: string | null
  /** The last month depreciation has actually been charged for. */
  depreciatedThrough: string | null
}

/**
 * Adds an asset to the register.
 *
 * Posts nothing unless `postAcquisitionCreditAccountId` is given — see the
 * note on `RegisterAssetInput` and the module docs on `fixed_assets`.
 */
export async function registerAsset(
  ctx: ActorContext,
  input: RegisterAssetInput,
): Promise<{ id: string; tag: string }> {
  requirePermission(ctx, 'accounting:journal')

  if (!Number.isInteger(input.costCents) || input.costCents <= 0) {
    throw new AssetError('An asset needs a cost in whole cents.')
  }
  if (!Number.isInteger(input.lifeMonths) || input.lifeMonths < 1) {
    throw new AssetError('An asset needs a useful life of at least one month.')
  }

  const salvageValueCents = input.salvageValueCents ?? 0
  if (salvageValueCents > input.costCents) {
    throw new AssetError('Salvage value cannot exceed cost — that would be an appreciating asset.')
  }

  const inServiceDate = input.inServiceDate ?? input.acquiredDate
  if (inServiceDate < input.acquiredDate) {
    throw new AssetError('An asset cannot go into service before it was acquired.')
  }

  return db.transaction(async (tx) => {
    const [assetAccount, accumulatedAccount, expenseAccount] = await Promise.all([
      resolveAccount(ctx, input.assetAccountId, SYSTEM_ACCOUNTS.fixedAssets, 'Fixed Assets', tx),
      resolveAccount(
        ctx,
        input.accumulatedAccountId,
        SYSTEM_ACCOUNTS.accumulatedDepreciation,
        'Accumulated Depreciation',
        tx,
      ),
      resolveAccount(
        ctx,
        input.expenseAccountId,
        SYSTEM_ACCOUNTS.depreciationExpense,
        'Depreciation Expense',
        tx,
      ),
    ])

    const tag = await nextTag(ctx.companyId, tx)

    const [asset] = await tx
      .insert(fixedAssets)
      .values({
        companyId: ctx.companyId,
        tag,
        name: input.name.trim(),
        description: input.description ?? null,
        category: input.category ?? null,
        serialNumber: input.serialNumber ?? null,
        location: input.location ?? null,
        costCents: input.costCents,
        salvageValueCents,
        lifeMonths: input.lifeMonths,
        method: input.method ?? 'straight_line',
        convention: input.convention ?? 'full_month',
        decliningFactorBp: input.decliningFactorBp ?? 20_000,
        acquiredDate: input.acquiredDate,
        inServiceDate,
        assetAccountId: assetAccount,
        accumulatedAccountId: accumulatedAccount,
        expenseAccountId: expenseAccount,
        vendorId: input.vendorId ?? null,
        projectId: input.projectId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: fixedAssets.id, tag: fixedAssets.tag })

    if (input.postAcquisitionCreditAccountId) {
      await createJournalEntry(
        ctx,
        {
          entryDate: input.acquiredDate,
          memo: `Acquired ${tag} — ${input.name}`,
          source: 'manual',
          sourceType: 'fixed_asset',
          sourceId: asset.id,
          lines: [
            {
              chartAccountId: assetAccount,
              debitCents: input.costCents,
              projectId: input.projectId ?? null,
            },
            {
              chartAccountId: input.postAcquisitionCreditAccountId,
              creditCents: input.costCents,
            },
          ],
        },
        tx,
      )
    }

    await recordAudit(
      ctx,
      {
        action: 'fixed_asset.register',
        entityType: 'fixed_asset',
        entityId: asset.id,
        after: {
          tag,
          name: input.name,
          costCents: input.costCents,
          lifeMonths: input.lifeMonths,
          posted: Boolean(input.postAcquisitionCreditAccountId),
        },
      },
      tx,
    )

    return asset
  })
}

/** The schedule an asset's terms imply, recomputed from the row. */
export function scheduleForAsset(asset: {
  costCents: number
  salvageValueCents: number
  lifeMonths: number
  method: DepreciationMethod
  convention: DepreciationConvention
  decliningFactorBp: number
  inServiceDate: string
}): SchedulePeriod[] {
  return depreciationSchedule({
    costCents: asset.costCents,
    salvageValueCents: asset.salvageValueCents,
    lifeMonths: asset.lifeMonths,
    method: asset.method,
    convention: asset.convention,
    inServiceMonth: monthStart(asset.inServiceDate),
    decliningFactor: asset.decliningFactorBp / 10_000,
  })
}

export type DueDepreciation = {
  assetId: string
  tag: string
  name: string
  periodStart: string
  periodEnd: string
  amountCents: number
  accumulatedCents: number
  expenseAccountId: string
  accumulatedAccountId: string
  projectId: string | null
  /** True when this is the last period of the asset's schedule. */
  finalPeriod: boolean
}

/**
 * What is owed and has not been charged, through a date.
 *
 * "Owed" is per month, not per run. A truck bought in January and registered
 * in June owes five months, and they are charged as five entries dated to
 * their own months — the months are when the truck was wearing out, and
 * lumping them into June would put five months of cost into one period's
 * profit and misstate both.
 */
export async function depreciationDue(
  ctx: ActorContext,
  opts: { throughDate: string; assetId?: string },
  exec: Executor = db,
): Promise<DueDepreciation[]> {
  requirePermission(ctx, 'accounting:view')

  const assets = await exec
    .select()
    .from(fixedAssets)
    .where(
      scoped(
        ctx,
        fixedAssets,
        opts.assetId ? eq(fixedAssets.id, opts.assetId) : undefined,
        // Disposed assets stop depreciating on the day they leave. A fully
        // depreciated one has nothing left to charge, and the schedule agrees
        // — but filtering here saves building the schedule to find that out.
        sql`${fixedAssets.status} <> 'disposed'`,
      ),
    )
    .orderBy(asc(fixedAssets.tag))

  if (assets.length === 0) return []

  const already = await exec
    .select({
      fixedAssetId: depreciationEntries.fixedAssetId,
      periodEnd: depreciationEntries.periodEnd,
    })
    .from(depreciationEntries)
    .where(
      scoped(
        ctx,
        depreciationEntries,
        inArray(
          depreciationEntries.fixedAssetId,
          assets.map((asset) => asset.id),
        ),
      ),
    )

  const charged = new Set(already.map((row) => `${row.fixedAssetId}:${row.periodEnd}`))
  const due: DueDepreciation[] = []

  for (const asset of assets) {
    const schedule = scheduleForAsset(asset)
    const lastPeriodEnd = schedule[schedule.length - 1]?.periodEnd

    // `throughDate` itself, not the end of its month. Rounding up meant that
    // asking "what is owed today" on the 16th of August offered a full month
    // of August depreciation dated the 31st — a future-dated entry for a month
    // that has not happened. A period is owed once it has ended; somebody who
    // genuinely wants August passes the 31st.
    for (const period of periodsThrough(schedule, opts.throughDate)) {
      if (charged.has(`${asset.id}:${period.periodEnd}`)) continue

      due.push({
        assetId: asset.id,
        tag: asset.tag,
        name: asset.name,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        amountCents: period.amountCents,
        accumulatedCents: period.accumulatedCents,
        expenseAccountId: asset.expenseAccountId,
        accumulatedAccountId: asset.accumulatedAccountId,
        projectId: asset.projectId,
        finalPeriod: period.periodEnd === lastPeriodEnd,
      })
    }
  }

  return due.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.tag.localeCompare(b.tag))
}

export type DepreciationRun = {
  periodEnd: string
  entryId: string
  entryNumber: number
  assetCount: number
  amountCents: number
}

/**
 * Charges every month of depreciation owed through a date.
 *
 * One journal entry per month covering every asset — "Depreciation — March
 * 2026" is what an accountant expects to find, not forty entries of $91.67.
 *
 * ## Running it twice is safe, and that matters more than it sounds
 *
 * It *will* be run twice. Somebody clicks the button, a scheduled job fires an
 * hour later, a period gets reopened and closed again. Each of those is
 * reasonable on its own.
 *
 * The claim is enforced by `unique(fixed_asset_id, period_end)` and one count
 * comparison: the insert is `onConflictDoNothing`, and if it claimed fewer
 * rows than the run expected, another actor took them and **the whole journal
 * entry rolls back** — because the insert runs inside the entry's own
 * transaction. The alternative, a read-then-write, lets both runs commit and
 * the asset depreciates twice in March, which nothing on any report reveals
 * until it is fully written off two years early.
 */
export async function runDepreciation(
  ctx: ActorContext,
  opts: { throughDate: string; assetId?: string; dimensions?: DimensionAssignment },
): Promise<DepreciationRun[]> {
  requirePermission(ctx, 'accounting:journal')

  const due = await depreciationDue(ctx, opts)
  if (due.length === 0) return []

  const byPeriod = new Map<string, DueDepreciation[]>()
  for (const row of due) {
    const existing = byPeriod.get(row.periodEnd) ?? []
    existing.push(row)
    byPeriod.set(row.periodEnd, existing)
  }

  const runs: DepreciationRun[] = []

  // One transaction per month rather than one for the whole catch-up: five
  // months of arrears where March falls in a closed period should post the
  // four that can, and say so, rather than refusing all five.
  for (const [periodEnd, rows] of [...byPeriod.entries()].sort()) {
    runs.push(await postPeriod(ctx, periodEnd, rows, opts.dimensions))
  }

  return runs
}

async function postPeriod(
  ctx: ActorContext,
  periodEnd: string,
  rows: DueDepreciation[],
  dimensions?: DimensionAssignment,
): Promise<DepreciationRun> {
  return db.transaction(async (tx) => {
    // Debits by expense account and job; credits by accumulated account. An
    // asset charged to a job carries the job on its expense line, which is
    // what makes depreciation show up in job profitability.
    const debits = new Map<string, { accountId: string; projectId: string | null; cents: number }>()
    const credits = new Map<string, number>()

    for (const row of rows) {
      const key = `${row.expenseAccountId}:${row.projectId ?? ''}`
      const debit = debits.get(key) ?? {
        accountId: row.expenseAccountId,
        projectId: row.projectId,
        cents: 0,
      }
      debit.cents += row.amountCents
      debits.set(key, debit)

      credits.set(
        row.accumulatedAccountId,
        (credits.get(row.accumulatedAccountId) ?? 0) + row.amountCents,
      )
    }

    const month = new Date(`${periodEnd}T00:00:00Z`).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: periodEnd,
        memo: `Depreciation — ${month}`,
        source: 'adjusting',
        sourceType: 'depreciation_run',
        lines: [
          ...[...debits.values()].map((debit) => ({
            chartAccountId: debit.accountId,
            debitCents: debit.cents,
            projectId: debit.projectId,
            dimensions,
          })),
          ...[...credits.entries()].map(([accountId, cents]) => ({
            chartAccountId: accountId,
            creditCents: cents,
            dimensions,
          })),
        ],
      },
      tx,
    )

    const claimed = await tx
      .insert(depreciationEntries)
      .values(
        rows.map((row) => ({
          companyId: ctx.companyId,
          fixedAssetId: row.assetId,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          amountCents: row.amountCents,
          accumulatedCents: row.accumulatedCents,
          journalEntryId: entry.id,
          createdBy: ctx.userId,
        })),
      )
      .onConflictDoNothing({
        target: [depreciationEntries.fixedAssetId, depreciationEntries.periodEnd],
      })
      .returning({ id: depreciationEntries.id })

    // The precondition, checked after the fact because the database is the
    // only thing that can check it. Fewer rows than expected means another run
    // claimed some of these periods between our read and our write — and this
    // throw takes the journal entry down with it.
    if (claimed.length !== rows.length) {
      throw new DepreciationRaceError(rows.length, claimed.length)
    }

    // An asset whose schedule has run out stops being active. The status is a
    // convenience for filtering, never the arithmetic — book value is always
    // cost less what was actually charged, computed from the entries.
    const finished = rows.filter((row) => row.finalPeriod).map((row) => row.assetId)
    if (finished.length > 0) {
      await tx
        .update(fixedAssets)
        .set({ status: 'fully_depreciated', updatedAt: new Date() })
        .where(
          scoped(ctx, fixedAssets, inArray(fixedAssets.id, finished), eq(fixedAssets.status, 'active')),
        )
    }

    await recordAudit(
      ctx,
      {
        action: 'fixed_asset.depreciate',
        entityType: 'journal_entry',
        entityId: entry.id,
        after: {
          periodEnd,
          assets: rows.length,
          amountCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
        },
      },
      tx,
    )

    return {
      periodEnd,
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      assetCount: rows.length,
      amountCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    }
  })
}

export type DisposalResult = {
  assetId: string
  bookValueCents: number
  gainLossCents: number
  entryId: string
  entryNumber: number
  arrearsCharged: number
}

/**
 * Sells, scraps, or writes off an asset.
 *
 * Depreciation is caught up to the disposal month **first**, so book value is
 * what the ledger actually says rather than what the schedule expected. An
 * asset last depreciated in month 14 and sold in month 20 has six months
 * uncharged; disposing at the schedule's book value would book a gain or loss
 * that the accumulated-depreciation account never supported, and the register
 * would stop reconciling on the spot.
 */
export async function disposeAsset(
  ctx: ActorContext,
  input: {
    assetId: string
    disposedOn: string
    proceedsCents: number
    /** Where the money landed. Omit for something scrapped for nothing. */
    proceedsAccountId?: string
    reason?: string
  },
): Promise<DisposalResult> {
  requirePermission(ctx, 'accounting:journal')

  if (!Number.isInteger(input.proceedsCents) || input.proceedsCents < 0) {
    throw new AssetError('Proceeds must be a whole number of cents, and not negative.')
  }
  if (input.proceedsCents > 0 && !input.proceedsAccountId) {
    throw new AssetError('Say which account the sale proceeds went into.')
  }

  // Outside the transaction: charging arrears posts its own entries per month,
  // and they belong to their own months whether or not the disposal succeeds.
  const arrears = await runDepreciation(ctx, {
    throughDate: input.disposedOn,
    assetId: input.assetId,
  })

  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(fixedAssets)
      .where(scoped(ctx, fixedAssets, eq(fixedAssets.id, input.assetId)))
      .limit(1)

    if (!asset) throw new AssetError('That asset is not on the register.')
    if (asset.status === 'disposed') throw new AssetError('That asset has already been disposed of.')
    if (input.disposedOn < asset.inServiceDate) {
      throw new AssetError('An asset cannot be disposed of before it went into service.')
    }

    const [charged] = await tx
      .select({ total: sql<string>`COALESCE(SUM(${depreciationEntries.amountCents}), 0)` })
      .from(depreciationEntries)
      .where(
        scoped(ctx, depreciationEntries, eq(depreciationEntries.fixedAssetId, input.assetId)),
      )

    const accumulatedCents = Number(charged?.total ?? 0)
    const { bookValueCents, gainLossCents } = disposalOutcome(
      asset.costCents,
      accumulatedCents,
      input.proceedsCents,
    )

    const [gainAccount, lossAccount] = await Promise.all([
      accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.gainOnDisposal, tx),
      accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.lossOnDisposal, tx),
    ])

    const lines: Array<{
      chartAccountId: string
      debitCents?: number
      creditCents?: number
      memo?: string
    }> = []

    // Take the accumulated depreciation off the books: it belonged to an asset
    // the company no longer owns.
    if (accumulatedCents > 0) {
      lines.push({
        chartAccountId: asset.accumulatedAccountId,
        debitCents: accumulatedCents,
        memo: 'Accumulated depreciation removed',
      })
    }
    if (input.proceedsCents > 0) {
      lines.push({
        chartAccountId: input.proceedsAccountId as string,
        debitCents: input.proceedsCents,
        memo: 'Disposal proceeds',
      })
    }
    lines.push({
      chartAccountId: asset.assetAccountId,
      creditCents: asset.costCents,
      memo: `Cost of ${asset.tag} removed`,
    })

    if (gainLossCents > 0) {
      if (!gainAccount) throw new AssetError('No Gain on Asset Disposal account is set up.')
      lines.push({ chartAccountId: gainAccount.id, creditCents: gainLossCents })
    } else if (gainLossCents < 0) {
      if (!lossAccount) throw new AssetError('No Loss on Asset Disposal account is set up.')
      lines.push({ chartAccountId: lossAccount.id, debitCents: -gainLossCents })
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.disposedOn,
        memo: `Disposal of ${asset.tag} — ${asset.name}`,
        source: 'adjusting',
        sourceType: 'fixed_asset_disposal',
        sourceId: asset.id,
        lines,
      },
      tx,
    )

    await tx
      .update(fixedAssets)
      .set({
        status: 'disposed',
        disposedOn: input.disposedOn,
        disposalProceedsCents: input.proceedsCents,
        disposalReason: input.reason ?? null,
        disposalJournalEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(scoped(ctx, fixedAssets, eq(fixedAssets.id, input.assetId)))

    await recordAudit(
      ctx,
      {
        action: 'fixed_asset.dispose',
        entityType: 'fixed_asset',
        entityId: asset.id,
        after: {
          disposedOn: input.disposedOn,
          proceedsCents: input.proceedsCents,
          bookValueCents,
          gainLossCents,
        },
      },
      tx,
    )

    return {
      assetId: asset.id,
      bookValueCents,
      gainLossCents,
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      arrearsCharged: arrears.length,
    }
  })
}

/** The register: every asset with what it cost and what it is worth now. */
export async function assetRegister(
  ctx: ActorContext,
  opts: { asOf?: string; includeDisposed?: boolean } = {},
): Promise<FixedAsset[]> {
  requirePermission(ctx, 'accounting:view')

  const assets = await db
    .select()
    .from(fixedAssets)
    .where(
      scoped(
        ctx,
        fixedAssets,
        opts.includeDisposed ? undefined : sql`${fixedAssets.status} <> 'disposed'`,
      ),
    )
    .orderBy(asc(fixedAssets.tag))

  if (assets.length === 0) return []

  const charged = await db
    .select({
      fixedAssetId: depreciationEntries.fixedAssetId,
      total: sql<string>`SUM(${depreciationEntries.amountCents})`,
      through: sql<string>`MAX(${depreciationEntries.periodEnd})`,
    })
    .from(depreciationEntries)
    .where(
      scoped(
        ctx,
        depreciationEntries,
        inArray(
          depreciationEntries.fixedAssetId,
          assets.map((asset) => asset.id),
        ),
        opts.asOf ? lte(depreciationEntries.periodEnd, opts.asOf) : undefined,
      ),
    )
    .groupBy(depreciationEntries.fixedAssetId)

  const byAsset = new Map(charged.map((row) => [row.fixedAssetId, row]))

  return assets.map((asset) => {
    const row = byAsset.get(asset.id)
    const accumulatedCents = Number(row?.total ?? 0)

    return {
      id: asset.id,
      tag: asset.tag,
      name: asset.name,
      category: asset.category,
      costCents: asset.costCents,
      salvageValueCents: asset.salvageValueCents,
      lifeMonths: asset.lifeMonths,
      method: asset.method,
      convention: asset.convention,
      decliningFactorBp: asset.decliningFactorBp,
      acquiredDate: asset.acquiredDate,
      inServiceDate: asset.inServiceDate,
      status: asset.status,
      accumulatedCents,
      // Cost less what was actually charged — never what the schedule
      // expected. The two differ whenever depreciation is behind, and the
      // ledger only knows about the first.
      bookValueCents: asset.costCents - accumulatedCents,
      disposedOn: asset.disposedOn,
      depreciatedThrough: row?.through ?? null,
    }
  })
}

export type AssetReconciliation = {
  asOf: string
  registerCostCents: number
  ledgerCostCents: number
  costAgrees: boolean
  registerAccumulatedCents: number
  ledgerAccumulatedCents: number
  accumulatedAgrees: boolean
  /** True only when both halves agree. The figure this module exists for. */
  agrees: boolean
  registerBookValueCents: number
}

/**
 * Proves the register against the ledger (spec §13, §19).
 *
 * Two comparisons, and both must hold:
 *
 *   Σ register cost          === Fixed Assets balance
 *   Σ depreciation charged   === Accumulated Depreciation balance
 *
 * Disposed assets are excluded from the register side and their reversal is
 * already out of the ledger side, so the two stay comparable.
 */
export async function reconcileFixedAssets(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<AssetReconciliation> {
  requirePermission(ctx, 'reports:financial')

  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const register = await assetRegister(ctx, { asOf })

  const registerCostCents = register.reduce((sum, asset) => sum + asset.costCents, 0)
  const registerAccumulatedCents = register.reduce((sum, asset) => sum + asset.accumulatedCents, 0)

  const accountIds = await db
    .select({ id: chartAccounts.id, number: chartAccounts.number })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        inArray(chartAccounts.number, [
          SYSTEM_ACCOUNTS.fixedAssets,
          SYSTEM_ACCOUNTS.accumulatedDepreciation,
        ]),
      ),
    )

  const balances = await Promise.all(
    accountIds.map(async (account) => ({
      number: account.number,
      cents: await ledgerBalance(ctx, account.id, asOf),
    })),
  )

  const ledgerCostCents =
    balances.find((row) => row.number === SYSTEM_ACCOUNTS.fixedAssets)?.cents ?? 0
  // Accumulated Depreciation is a contra-asset: it carries a credit balance,
  // so the debit-normal figure is negative and the register's positive
  // accumulated total is its absolute value.
  //
  // `|| 0` because negating zero in JavaScript gives `-0`, which formats as
  // "-$0.00" on a screen and reads as a defect. The same collapse the cash
  // flow statement needed in Phase 12.
  const ledgerAccumulatedCents =
    -(balances.find((row) => row.number === SYSTEM_ACCOUNTS.accumulatedDepreciation)?.cents ?? 0) ||
    0

  const costAgrees = registerCostCents === ledgerCostCents
  const accumulatedAgrees = registerAccumulatedCents === ledgerAccumulatedCents

  return {
    asOf,
    registerCostCents,
    ledgerCostCents,
    costAgrees,
    registerAccumulatedCents,
    ledgerAccumulatedCents,
    accumulatedAgrees,
    agrees: costAgrees && accumulatedAgrees,
    registerBookValueCents: registerCostCents - registerAccumulatedCents,
  }
}

/** Debit-normal balance of one account through a date, from posted lines. */
async function ledgerBalance(
  ctx: ActorContext,
  chartAccountId: string,
  asOf: string,
): Promise<number> {
  const [row] = await db
    .select({
      debit: sql<string>`COALESCE(SUM(${journalLines.debitCents}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalLines.creditCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        lte(journalEntries.entryDate, asOf),
        eq(journalLines.chartAccountId, chartAccountId),
      ),
    )

  return Number(row?.debit ?? 0) - Number(row?.credit ?? 0)
}

/**
 * Chart accounts money can arrive in or be paid from, for the screens.
 *
 * Deliberately not `depositableAccounts` from the banking module, which
 * returns **financial** accounts — the bank connection, not the ledger
 * account. Reusing it here handed the journal a financial-account id and
 * produced "one or more chart accounts were not found" at post time, which is
 * the right refusal and a useless message to read on a disposal form.
 */
export async function cashChartAccounts(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({ id: chartAccounts.id, number: chartAccounts.number, name: chartAccounts.name })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        eq(chartAccounts.isActive, true),
        sql`COALESCE(${chartAccounts.subtype}, '') IN ('bank', 'cash')`,
      ),
    )
    .orderBy(asc(chartAccounts.number))
}

/** Every month charged on one asset, newest first. */
export async function depreciationHistory(ctx: ActorContext, assetId: string) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: depreciationEntries.id,
      periodStart: depreciationEntries.periodStart,
      periodEnd: depreciationEntries.periodEnd,
      amountCents: depreciationEntries.amountCents,
      accumulatedCents: depreciationEntries.accumulatedCents,
      entryNumber: journalEntries.entryNumber,
    })
    .from(depreciationEntries)
    .innerJoin(journalEntries, eq(journalEntries.id, depreciationEntries.journalEntryId))
    .where(scoped(ctx, depreciationEntries, eq(depreciationEntries.fixedAssetId, assetId)))
    .orderBy(desc(depreciationEntries.periodEnd))
}

async function resolveAccount(
  ctx: ActorContext,
  given: string | undefined,
  fallbackNumber: string,
  label: string,
  exec: Executor,
): Promise<string> {
  if (given) return given

  const account = await accountByNumber(ctx.companyId, fallbackNumber, exec)
  if (!account) {
    throw new AssetError(`No ${label} account (${fallbackNumber}) is set up on these books.`)
  }
  return account.id
}

/** `FA-0001`, `FA-0002`. Sequential per company. */
async function nextTag(companyId: string, exec: Executor): Promise<string> {
  const [row] = await exec
    .select({ max: sql<string | null>`MAX(${fixedAssets.tag})` })
    .from(fixedAssets)
    .where(eq(fixedAssets.companyId, companyId))

  const current = row?.max ? Number(row.max.replace(/\D/g, '')) : 0
  return `FA-${String(current + 1).padStart(4, '0')}`
}
