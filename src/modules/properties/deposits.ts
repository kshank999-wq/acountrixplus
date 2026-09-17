import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  customers,
  depositMovements,
  financialAccounts,
  journalLines,
  journalEntries,
  leases,
  properties,
  propertyUnits,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry } from '@/modules/ledger/journal'
import { settleInvoiceWithoutCash } from '@/modules/receivables/service'
import { PropertyError, propertyDimension } from './service'
import { bankGlAccountFor } from '@/modules/banking/bank-guard'
import { spends } from '@/modules/fx/spent-against'
import { functionalCurrency } from '@/modules/fx/service'
import { formatCents } from '@/lib/money'

/**
 * Security deposits (spec §5 "tenants", §13, §19).
 *
 * ## A deposit is somebody else's money
 *
 * That single sentence decides every posting in this file. A deposit received
 * is **not income**: the landlord is holding cash they may well have to give
 * back, so it credits `2580 Tenant Security Deposits`, a liability, and the
 * profit and loss never sees it. Refunding it is **not an expense** for the
 * same reason — it is the liability going away.
 *
 * The only moment a deposit touches the profit and loss is when it is *kept*,
 * and even then it depends on what it is kept for:
 *
 *  - **Against an unpaid invoice**, the revenue was already recognised when
 *    that invoice was raised. Applying the deposit settles the receivable and
 *    recognises nothing further. Doing otherwise would count the same rent
 *    twice — once on the invoice and once on the deposit.
 *  - **Against damage, with no invoice**, nothing has been recognised yet, so
 *    this is the moment it becomes income.
 *
 * Getting that distinction wrong is the classic property-books error, and it
 * always errs the same way: it overstates income by exactly the deposits held.
 */

export type DepositPosition = {
  leaseId: string
  requiredCents: number
  receivedCents: number
  refundedCents: number
  appliedCents: number
  /** received − refunded − applied. Derived, never stored. */
  heldCents: number
  /** Negative when the tenant still owes part of the agreed deposit. */
  shortfallCents: number
}

async function depositAccount(ctx: ActorContext, exec: Executor = db) {
  const account = await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.tenantSecurityDeposits, exec)

  if (!account) {
    throw new PropertyError(
      'Deposits need a Tenant Security Deposits account (2580), which this chart of accounts does not have.',
    )
  }

  return account
}

/**
 * What is held on one lease, computed from the movements.
 *
 * Never read from a column. Phase 20 shipped a cached `reference_count` and
 * the delete path trusted it; a drifted count would have leaked storage or
 * destroyed evidence, and the fix was to make the rows the authority. Here the
 * stakes are somebody else's money — a drifted balance is a landlord refunding
 * cash they no longer hold — so the rows are the authority again.
 */
export async function depositPosition(
  ctx: ActorContext,
  leaseId: string,
  exec: Executor = db,
): Promise<DepositPosition> {
  const [lease] = await exec
    .select({ id: leases.id, requiredCents: leases.depositRequiredCents })
    .from(leases)
    .where(scoped(ctx, leases, eq(leases.id, leaseId)))
    .limit(1)

  if (!lease) throw new PropertyError('That tenancy does not exist.')

  const [totals] = await exec
    .select({
      received: sql<string>`coalesce(sum(${depositMovements.amountCents}) filter (where ${depositMovements.kind} = 'received'), 0)`,
      refunded: sql<string>`coalesce(sum(${depositMovements.amountCents}) filter (where ${depositMovements.kind} = 'refunded'), 0)`,
      applied: sql<string>`coalesce(sum(${depositMovements.amountCents}) filter (where ${depositMovements.kind} = 'applied'), 0)`,
    })
    .from(depositMovements)
    .where(scoped(ctx, depositMovements, eq(depositMovements.leaseId, leaseId)))

  const receivedCents = Number(totals?.received ?? 0)
  const refundedCents = Number(totals?.refunded ?? 0)
  const appliedCents = Number(totals?.applied ?? 0)
  const heldCents = receivedCents - refundedCents - appliedCents

  return {
    leaseId,
    requiredCents: lease.requiredCents,
    receivedCents,
    refundedCents,
    appliedCents,
    heldCents,
    shortfallCents: Math.max(0, lease.requiredCents - heldCents),
  }
}

/**
 * Takes a deposit in.
 *
 * Debits the bank, credits the liability. Nothing reaches the profit and loss,
 * which is the entire point: a landlord who has taken £30,000 of deposits on
 * ten flats has not earned £30,000.
 */
export async function receiveDeposit(
  ctx: ActorContext,
  input: {
    leaseId: string
    amountCents: number
    occurredOn: string
    financialAccountId: string
    memo?: string | null
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'properties')

  if (input.amountCents <= 0) {
    throw new PropertyError('A deposit must be more than nothing.')
  }

  const liability = await depositAccount(ctx)

  return db.transaction(async (tx) => {
    const lease = await leaseForMovement(ctx, input.leaseId, tx)

    const [bank] = await tx
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
      .limit(1)

    if (!bank) throw new PropertyError('That account does not exist.')

    // Phase 133: the ledger account, and whether this account may take it.
    const bankGl = await bankGlAccountFor(ctx, input.financialAccountId, 'holding this deposit', tx)

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.occurredOn,
        memo: `Security deposit received — ${lease.tenantName}, ${lease.propertyName} ${lease.unitCode}`,
        source: 'manual',
        sourceType: 'lease_deposit',
        sourceId: input.leaseId,
        lines: [
          { chartAccountId: bankGl, debitCents: input.amountCents },
          {
            chartAccountId: liability.id,
            creditCents: input.amountCents,
            memo: 'Held on behalf of the tenant',
          },
        ],
      },
      tx,
    )

    const [row] = await tx
      .insert(depositMovements)
      .values({
        companyId: ctx.companyId,
        leaseId: input.leaseId,
        kind: 'received',
        amountCents: input.amountCents,
        occurredOn: input.occurredOn,
        journalEntryId: entry.id,
        memo: input.memo?.trim() || null,
        recordedBy: ctx.userId,
      })
      .returning({ id: depositMovements.id })

    await recordAudit(
      ctx,
      {
        action: 'deposit.receive',
        entityType: 'lease',
        entityId: input.leaseId,
        after: { amountCents: input.amountCents, occurredOn: input.occurredOn },
      },
      tx,
    )

    return row
  })
}

/**
 * Gives a deposit back.
 *
 * Debits the liability, credits the bank. **Not an expense** — the money was
 * never income, so returning it cannot be a cost. Booking it to an expense
 * account is how a set of property books ends up showing a loss in every month
 * a tenant moves out.
 */
export async function refundDeposit(
  ctx: ActorContext,
  input: {
    leaseId: string
    amountCents: number
    occurredOn: string
    financialAccountId: string
    memo?: string | null
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'properties')

  if (input.amountCents <= 0) {
    throw new PropertyError('A refund must be more than nothing.')
  }

  const liability = await depositAccount(ctx)

  return db.transaction(async (tx) => {
    const lease = await leaseForMovement(ctx, input.leaseId, tx)
    const position = await depositPosition(ctx, input.leaseId, tx)

    // You cannot give back what you are not holding. Without this the ledger
    // would show a debit balance on a liability account — the books saying the
    // tenant owes the landlord their own deposit.
    if (input.amountCents > position.heldCents) {
      throw new PropertyError(
        `Only ${position.heldCents} is held on this tenancy; ${input.amountCents} cannot be refunded.`,
      )
    }

    const [bank] = await tx
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
      .limit(1)

    if (!bank) throw new PropertyError('That account does not exist.')

    // Phase 133: the ledger account, and whether this account may take it.
    const bankGl = await bankGlAccountFor(
      ctx,
      input.financialAccountId,
      'returning this deposit',
      tx,
    )

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.occurredOn,
        memo: `Security deposit refunded — ${lease.tenantName}, ${lease.propertyName} ${lease.unitCode}`,
        source: 'manual',
        sourceType: 'lease_deposit',
        sourceId: input.leaseId,
        lines: [
          { chartAccountId: liability.id, debitCents: input.amountCents },
          { chartAccountId: bankGl, creditCents: input.amountCents },
        ],
      },
      tx,
    )

    const [row] = await tx
      .insert(depositMovements)
      .values({
        companyId: ctx.companyId,
        leaseId: input.leaseId,
        kind: 'refunded',
        amountCents: input.amountCents,
        occurredOn: input.occurredOn,
        journalEntryId: entry.id,
        memo: input.memo?.trim() || null,
        recordedBy: ctx.userId,
      })
      .returning({ id: depositMovements.id })

    await recordAudit(
      ctx,
      {
        action: 'deposit.refund',
        entityType: 'lease',
        entityId: input.leaseId,
        after: { amountCents: input.amountCents, occurredOn: input.occurredOn },
      },
      tx,
    )

    return row
  })
}

/**
 * Keeps part of a deposit.
 *
 * Two shapes, and the difference is whether the thing being covered has
 * already been recognised as income:
 *
 *  - **`invoiceId` given** — the deposit settles unpaid rent. Debit the
 *    liability, credit Accounts Receivable. The invoice already recognised
 *    that revenue; recognising it again here would count the same month's rent
 *    twice, and the books would balance while the income statement lied.
 *  - **no `invoiceId`** — the deposit is kept for damage or cleaning, which
 *    nothing has billed. Debit the liability, credit income. *This* is the
 *    moment somebody else's money becomes the landlord's.
 */
export async function applyDeposit(
  ctx: ActorContext,
  input: {
    leaseId: string
    amountCents: number
    occurredOn: string
    /** Settles this invoice. Omit when keeping it against damage. */
    invoiceId?: string | null
    /** Where kept-for-damage income lands. Defaults to Rental Income. */
    incomeAccountId?: string | null
    memo?: string | null
  },
): Promise<{
  id: string
  recognisedIncome: boolean
  /**
   * What actually came off the tenancy, in the company's own money.
   *
   * Returned so a caller reporting the result does not have to reach for the
   * face amount somebody typed: `applyDepositAction` said
   * `formatCents(parsed.amountCents)` and rendered a €400 application as
   * "$400.00 applied to the invoice" (Phase 151).
   */
  appliedCents: number
}> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'properties')

  if (input.amountCents <= 0) {
    throw new PropertyError('An amount must be more than nothing.')
  }

  const liability = await depositAccount(ctx)

  const receivable = await accountByNumber(ctx.companyId, '1100')
  if (!receivable) throw new PropertyError('Accounts Receivable is missing from the chart.')

  return db.transaction(async (tx) => {
    const lease = await leaseForMovement(ctx, input.leaseId, tx)
    const position = await depositPosition(ctx, input.leaseId, tx)

    let creditAccountId: string
    let memo: string
    let recognisedIncome: boolean
    /**
     * What comes off the tenancy, in the company's own money (Phase 151).
     *
     * This was `input.amountCents` throughout — the invoice's **face** amount.
     * On a euro invoice against a dollar deposit that is not the same kind of
     * number as the holding, so the check `input.amountCents > position.heldCents`
     * compared two currencies and the credit to Accounts Receivable was a euro
     * figure posted as dollars. $1,050 held and €1,000 applied asked
     * `100000 > 105000`, went ahead, and spent $1,100 of a $1,050 deposit.
     */
    let appliedCents = input.amountCents

    if (input.invoiceId) {
      // Settles the receivable, and nothing else. Deliberately not a payment
      // row: a receipt with no bank account reads as cash awaiting banking,
      // and this is not cash — see `settleInvoiceWithoutCash`.
      const settled = await settleInvoiceWithoutCash(
        ctx,
        { invoiceId: input.invoiceId, amountCents: input.amountCents },
        tx,
      )

      // Both figures in the company's own money before they are compared, and
      // the refusal names each in its own currency. Inside the transaction, so
      // a refusal unwinds the settlement it had to perform to learn the worth.
      const home = await functionalCurrency(ctx.companyId, tx)
      const verdict = spends({
        heldCents: position.heldCents,
        faceCents: input.amountCents,
        functionalCents: settled.functionalCents,
        documentCurrency: settled.currency,
        homeCurrency: home,
      })

      if (!verdict.ok) throw new PropertyError(verdict.why)

      appliedCents = verdict.costsCents
      creditAccountId = receivable.id
      memo = `Deposit applied to invoice ${settled.number}`
      recognisedIncome = false
    } else {
      if (input.amountCents > position.heldCents) {
        throw new PropertyError(
          `Only ${formatCents(position.heldCents)} is held on this tenancy, so ` +
            `${formatCents(input.amountCents)} cannot be applied.`,
        )
      }

      const income = input.incomeAccountId
        ? await ownedAccount(ctx, input.incomeAccountId, tx)
        : await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.rentalIncome, tx)

      if (!income) {
        throw new PropertyError(
          'Keeping a deposit needs an income account, and none was given or found.',
        )
      }

      creditAccountId = income.id
      memo = 'Deposit kept'
      recognisedIncome = true
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.occurredOn,
        memo: `${memo} — ${lease.tenantName}, ${lease.propertyName} ${lease.unitCode}`,
        source: 'manual',
        sourceType: 'lease_deposit',
        sourceId: input.leaseId,
        lines: [
          { chartAccountId: liability.id, debitCents: appliedCents },
          {
            chartAccountId: creditAccountId,
            creditCents: appliedCents,
            memo: input.memo?.trim() || memo,
            // Tagged with the property, so a kept deposit shows up on that
            // property's profit and loss alongside its rent.
            dimensions: recognisedIncome
              ? { [lease.dimensionId]: lease.dimensionValueId }
              : undefined,
          },
        ],
      },
      tx,
    )

    const [row] = await tx
      .insert(depositMovements)
      .values({
        companyId: ctx.companyId,
        leaseId: input.leaseId,
        kind: 'applied',
        // The worth, not the face amount — this is what the tenancy gave up,
        // and `depositPosition` sums these to say what is left.
        amountCents: appliedCents,
        occurredOn: input.occurredOn,
        journalEntryId: entry.id,
        invoiceId: input.invoiceId ?? null,
        memo: input.memo?.trim() || null,
        recordedBy: ctx.userId,
      })
      .returning({ id: depositMovements.id })

    await recordAudit(
      ctx,
      {
        action: 'deposit.apply',
        entityType: 'lease',
        entityId: input.leaseId,
        after: {
          amountCents: input.amountCents,
          invoiceId: input.invoiceId ?? null,
          recognisedIncome,
        },
      },
      tx,
    )

    return { id: row.id, recognisedIncome, appliedCents }
  })
}

async function ownedAccount(ctx: ActorContext, accountId: string, exec: Executor) {
  const [row] = await exec
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, accountId)))
    .limit(1)

  return row ?? null
}

async function leaseForMovement(ctx: ActorContext, leaseId: string, exec: Executor) {
  const [row] = await exec
    .select({
      id: leases.id,
      tenantName: customers.name,
      propertyName: properties.name,
      unitCode: propertyUnits.code,
      dimensionValueId: properties.dimensionValueId,
    })
    .from(leases)
    .innerJoin(propertyUnits, eq(propertyUnits.id, leases.unitId))
    .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
    .innerJoin(customers, eq(customers.id, leases.customerId))
    .where(scoped(ctx, leases, eq(leases.id, leaseId)))
    .limit(1)

  if (!row) throw new PropertyError('That tenancy does not exist.')

  const dimension = await propertyDimension(ctx, exec)

  return { ...row, dimensionId: dimension.id }
}

export type DepositsHeld = {
  asOf: string
  /** Σ held across every lease, from the movements. */
  registerCents: number
  /** The 2580 balance the ledger holds. */
  ledgerCents: number
  agrees: boolean
  leases: Array<{
    leaseId: string
    propertyName: string
    unitCode: string
    tenantName: string
    heldCents: number
    requiredCents: number
    shortfallCents: number
  }>
}

/**
 * Proves the deposits register against the ledger (spec §19).
 *
 * Σ movements === the `2580` balance, the same shape as Phase 16's fixed asset
 * reconciliation. A landlord who cannot show that the deposits they are
 * holding match the liability on their balance sheet has a problem no report
 * will fix for them, and in most jurisdictions a legal one.
 */
export async function depositsHeld(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<DepositsHeld> {
  requirePermission(ctx, 'reports:financial')

  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)

  const rows = await db
    .select({
      leaseId: leases.id,
      propertyName: properties.name,
      unitCode: propertyUnits.code,
      tenantName: customers.name,
      requiredCents: leases.depositRequiredCents,
      received: sql<string>`coalesce(sum(${depositMovements.amountCents}) filter (where ${depositMovements.kind} = 'received' and ${depositMovements.occurredOn} <= ${asOf}), 0)`,
      refunded: sql<string>`coalesce(sum(${depositMovements.amountCents}) filter (where ${depositMovements.kind} = 'refunded' and ${depositMovements.occurredOn} <= ${asOf}), 0)`,
      applied: sql<string>`coalesce(sum(${depositMovements.amountCents}) filter (where ${depositMovements.kind} = 'applied' and ${depositMovements.occurredOn} <= ${asOf}), 0)`,
    })
    .from(leases)
    .innerJoin(propertyUnits, eq(propertyUnits.id, leases.unitId))
    .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
    .innerJoin(customers, eq(customers.id, leases.customerId))
    .leftJoin(depositMovements, eq(depositMovements.leaseId, leases.id))
    .where(scoped(ctx, leases))
    .groupBy(
      leases.id,
      properties.name,
      propertyUnits.code,
      customers.name,
      leases.depositRequiredCents,
    )
    .orderBy(asc(properties.name), asc(propertyUnits.code))

  const held = rows
    .map((row) => {
      const heldCents =
        Number(row.received) - Number(row.refunded) - Number(row.applied)
      return {
        leaseId: row.leaseId,
        propertyName: row.propertyName,
        unitCode: row.unitCode,
        tenantName: row.tenantName,
        heldCents,
        requiredCents: row.requiredCents,
        shortfallCents: Math.max(0, row.requiredCents - heldCents),
      }
    })
    .filter((row) => row.heldCents !== 0 || row.shortfallCents !== 0)

  const registerCents = held.reduce((sum, row) => sum + row.heldCents, 0)
  const ledgerCents = await liabilityBalance(ctx, asOf)

  return {
    asOf,
    registerCents,
    ledgerCents,
    agrees: registerCents === ledgerCents,
    leases: held,
  }
}

/**
 * Credit-normal balance of 2580 through a date.
 *
 * Negated because the ledger stores debit-normal, and a liability's natural
 * balance is a credit — so the figure a landlord recognises as "deposits I am
 * holding" is the negative of what the raw sum gives. `|| 0` collapses `-0`,
 * which formats as "-$0.00" and reads as a defect; the same collapse Phase 12
 * needed on the cash flow statement.
 */
async function liabilityBalance(ctx: ActorContext, asOf: string): Promise<number> {
  const account = await depositAccount(ctx)

  const [row] = await db
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.debitCents}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.creditCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      scoped(
        ctx,
        journalLines,
        eq(journalLines.chartAccountId, account.id),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntries.entryDate} <= ${asOf}`,
      ),
    )

  return -(Number(row?.debit ?? 0) - Number(row?.credit ?? 0)) || 0
}

export type DepositMovementRow = {
  id: string
  leaseId: string
  kind: 'received' | 'refunded' | 'applied'
  amountCents: number
  occurredOn: string
  memo: string | null
  invoiceId: string | null
}

export async function listDepositMovements(
  ctx: ActorContext,
  opts: { leaseId?: string; leaseIds?: string[] } = {},
): Promise<DepositMovementRow[]> {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: depositMovements.id,
      leaseId: depositMovements.leaseId,
      kind: depositMovements.kind,
      amountCents: depositMovements.amountCents,
      occurredOn: depositMovements.occurredOn,
      memo: depositMovements.memo,
      invoiceId: depositMovements.invoiceId,
    })
    .from(depositMovements)
    .where(
      scoped(
        ctx,
        depositMovements,
        opts.leaseId ? eq(depositMovements.leaseId, opts.leaseId) : undefined,
        opts.leaseIds?.length
          ? inArray(depositMovements.leaseId, opts.leaseIds)
          : undefined,
      ),
    )
    .orderBy(asc(depositMovements.occurredOn))
}
