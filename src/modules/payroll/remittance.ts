import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import { formatCents } from '@/lib/money'
import {
  chartAccounts,
  financialAccounts,
  journalEntries,
  journalLines,
  taxRemittances,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { createJournalEntry } from '@/modules/ledger/journal'
import { PAYROLL_ACCOUNTS } from './accounts'
import { Refusal } from '@/modules/errors'

/**
 * Remitting what was withheld (spec §13, §19).
 *
 * ## What a remittance is here
 *
 * Money leaving the bank to an agency, against a liability that was accrued
 * when payroll posted or when sales tax was charged:
 *
 * ```
 *   Dr  Payroll Liabilities / Sales Tax Payable    amount remitted
 *       Cr  Bank                                       amount remitted
 * ```
 *
 * No expense. The expense happened when the payroll was run or the sale was
 * made; this is settling a debt. Booking a remittance to an expense account is
 * the second commonest payroll error after mis-splitting withholding, and it
 * double-counts the cost.
 *
 * ## What a remittance is not
 *
 * It is not a payment and it is not a filing. This system does not move money
 * and does not submit returns — spec §19 requires a security review before
 * production use of tax filing, and this codebase has not had one. A
 * remittance row records that somebody paid an agency, in the same way a
 * `payments` row records that somebody paid a supplier.
 */

export type RemittanceKind = 'payroll' | 'sales_tax'

export type LiabilityPosition = {
  accountId: string
  accountNumber: string
  accountName: string
  /** Accrued into this account over the period, from posted entries. */
  accruedCents: number
  /** Remitted out of it over the period. */
  remittedCents: number
  /** What the ledger says is still owed, as of the end date. */
  balanceCents: number
}

/**
 * What is owed, per liability account, as of a date.
 *
 * Read from the **ledger**, not from the payroll runs. The runs are the reason
 * the liability exists, but the balance is an accounting fact — and a figure
 * somebody is about to pay an agency should come from the same place the
 * balance sheet gets it, or the two will disagree at the worst moment.
 */
export async function liabilityPositions(
  ctx: ActorContext,
  opts: { asOfDate: string; kind?: RemittanceKind },
): Promise<LiabilityPosition[]> {
  requirePermission(ctx, 'tax:view')

  const numbers =
    opts.kind === 'sales_tax'
      ? [PAYROLL_ACCOUNTS.salesTaxPayable]
      : opts.kind === 'payroll'
        ? [PAYROLL_ACCOUNTS.payrollLiabilities, PAYROLL_ACCOUNTS.netPayPayable]
        : [
            PAYROLL_ACCOUNTS.payrollLiabilities,
            PAYROLL_ACCOUNTS.netPayPayable,
            PAYROLL_ACCOUNTS.salesTaxPayable,
          ]

  const accounts = await db
    .select()
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, inArray(chartAccounts.number, numbers)))
    .orderBy(asc(chartAccounts.number))

  if (accounts.length === 0) return []

  const rows = await db
    .select({
      accountId: journalLines.chartAccountId,
      // Liability accounts are credit-normal, so the balance is credits minus
      // debits. Flipped once, here, rather than at three call sites.
      credits: sql<string>`coalesce(sum(${journalLines.creditCents}), 0)`,
      debits: sql<string>`coalesce(sum(${journalLines.debitCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      scoped(
        ctx,
        journalLines,
        eq(journalEntries.status, 'posted'),
        lte(journalEntries.entryDate, opts.asOfDate),
        inArray(
          journalLines.chartAccountId,
          accounts.map((account) => account.id),
        ),
      ),
    )
    .groupBy(journalLines.chartAccountId)

  const byAccount = new Map(
    rows.map((row) => [row.accountId, { credits: Number(row.credits), debits: Number(row.debits) }]),
  )

  return accounts.map((account) => {
    const totals = byAccount.get(account.id) ?? { credits: 0, debits: 0 }
    return {
      accountId: account.id,
      accountNumber: account.number,
      accountName: account.name,
      accruedCents: totals.credits,
      remittedCents: totals.debits,
      balanceCents: totals.credits - totals.debits,
    }
  })
}

/**
 * Records a remittance and posts the entry that clears the liability.
 *
 * Refuses to remit more than the ledger says is owed. That is a real guard
 * rather than a nicety: over-remitting drives a liability account negative,
 * which reads on a balance sheet as the agency owing *you* money, and nobody
 * notices until a reconciliation months later.
 */
export async function recordRemittance(
  ctx: ActorContext,
  input: {
    kind: RemittanceKind
    agency: string
    periodStart: string
    periodEnd: string
    paidOn: string
    amountCents: number
    liabilityAccountId: string
    financialAccountId: string
    reference?: string
  },
) {
  requirePermission(ctx, 'tax:manage')
  requirePermission(ctx, 'accounting:journal')

  if (input.amountCents <= 0) {
    throw new Refusal('A remittance must be greater than zero.')
  }
  if (input.periodEnd < input.periodStart) {
    throw new Refusal('The period end must be on or after the period start.')
  }

  const [liability] = await db
    .select()
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, input.liabilityAccountId)))
    .limit(1)

  if (!liability) throw new Error('Liability account not found')
  if (liability.type !== 'liability') {
    throw new Refusal(
      `${liability.number} ${liability.name} is not a liability account. A remittance clears a debt.`,
    )
  }

  // The kind and the account have to agree. Booking a payroll remittance
  // against Sales Tax Payable balances perfectly and leaves both accounts
  // wrong — payroll understated, sales tax overstated — which nobody notices
  // until one of the two returns is being prepared and neither foots.
  const expected: string[] =
    input.kind === 'sales_tax'
      ? [PAYROLL_ACCOUNTS.salesTaxPayable]
      : [PAYROLL_ACCOUNTS.payrollLiabilities, PAYROLL_ACCOUNTS.netPayPayable]

  if (!expected.includes(liability.number)) {
    throw new Refusal(
      `A ${input.kind === 'sales_tax' ? 'sales tax' : 'payroll'} remittance clears ` +
        `${expected.join(' or ')}, not ${liability.number} ${liability.name}.`,
    )
  }

  const [bank] = await db
    .select()
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
    .limit(1)

  if (!bank) throw new Error('Financial account not found')

  const positions = await liabilityPositions(ctx, { asOfDate: input.paidOn })
  const position = positions.find((entry) => entry.accountId === input.liabilityAccountId)
  const owed = position?.balanceCents ?? 0

  if (input.amountCents > owed) {
    throw new Refusal(
      `The ledger shows ${formatCents(owed)} owed on ${liability.number} ${liability.name} as at ${input.paidOn}, ` +
        `but this remittance is ${formatCents(input.amountCents)}. Post the accrual first, or check the amount.`,
    )
  }

  return db.transaction(async (tx) => {
    const [remittance] = await tx
      .insert(taxRemittances)
      .values({
        companyId: ctx.companyId,
        kind: input.kind,
        agency: input.agency,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        paidOn: input.paidOn,
        amountCents: input.amountCents,
        liabilityAccountId: input.liabilityAccountId,
        financialAccountId: input.financialAccountId,
        reference: input.reference ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.paidOn,
        memo: `${input.agency} — ${input.kind === 'payroll' ? 'payroll' : 'sales tax'} remittance ${input.periodStart} to ${input.periodEnd}`,
        source: 'remittance',
        sourceType: 'tax_remittance',
        sourceId: remittance.id,
        lines: [
          // No expense on either side. The cost was recognized when the
          // payroll ran or the sale was made.
          { chartAccountId: input.liabilityAccountId, debitCents: input.amountCents },
          { chartAccountId: bank.chartAccountId, creditCents: input.amountCents },
        ],
      },
      tx,
    )

    await tx
      .update(taxRemittances)
      .set({ journalEntryId: entry.id })
      .where(eq(taxRemittances.id, remittance.id))

    await recordAudit(
      ctx,
      {
        action: 'remittance.record',
        entityType: 'tax_remittance',
        entityId: remittance.id,
        after: {
          kind: input.kind,
          agency: input.agency,
          amountCents: input.amountCents,
          period: `${input.periodStart}..${input.periodEnd}`,
          reference: input.reference ?? null,
        },
      },
      tx,
    )

    return { ...remittance, journalEntryId: entry.id }
  })
}

export async function listRemittances(
  ctx: ActorContext,
  opts: { kind?: RemittanceKind; limit?: number } = {},
) {
  requirePermission(ctx, 'tax:view')

  return db
    .select({
      id: taxRemittances.id,
      kind: taxRemittances.kind,
      agency: taxRemittances.agency,
      periodStart: taxRemittances.periodStart,
      periodEnd: taxRemittances.periodEnd,
      paidOn: taxRemittances.paidOn,
      amountCents: taxRemittances.amountCents,
      reference: taxRemittances.reference,
      accountNumber: chartAccounts.number,
      accountName: chartAccounts.name,
    })
    .from(taxRemittances)
    .innerJoin(chartAccounts, eq(chartAccounts.id, taxRemittances.liabilityAccountId))
    .where(
      scoped(
        ctx,
        taxRemittances,
        opts.kind ? eq(taxRemittances.kind, opts.kind) : undefined,
      ),
    )
    .orderBy(desc(taxRemittances.paidOn))
    .limit(opts.limit ?? 50)
}

/**
 * Remittances within a period, for reconciling a liability account.
 *
 * The workpaper question is "this account moved by X — what made up X", and
 * this is the half of the answer that is not an accrual.
 */
export async function remittancesInPeriod(
  ctx: ActorContext,
  range: { startDate: string; endDate: string; kind?: RemittanceKind },
) {
  requirePermission(ctx, 'tax:view')

  return db
    .select()
    .from(taxRemittances)
    .where(
      scoped(
        ctx,
        taxRemittances,
        gte(taxRemittances.paidOn, range.startDate),
        lte(taxRemittances.paidOn, range.endDate),
        range.kind ? eq(taxRemittances.kind, range.kind) : undefined,
      ),
    )
    .orderBy(asc(taxRemittances.paidOn))
}

/** The bank accounts a remittance can be paid from. */
export async function remittanceAccounts(ctx: ActorContext) {
  requirePermission(ctx, 'tax:view')

  return db
    .select({
      id: financialAccounts.id,
      name: financialAccounts.name,
      mask: financialAccounts.mask,
    })
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts))
    .orderBy(asc(financialAccounts.name))
}

/** Resolves the sales tax liability account, creating nothing. */
export async function salesTaxAccount(ctx: ActorContext) {
  return accountByNumber(ctx.companyId, PAYROLL_ACCOUNTS.salesTaxPayable)
}
