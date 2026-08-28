import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { paymentSettings } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DomainError } from '@/modules/errors'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import type { FeeSchedule } from './settlement'

/**
 * How a company takes card payments (spec §13, §19).
 *
 * Off until somebody says otherwise, like chasing and for a related reason:
 * turning this on puts a **Pay** button on a page the company's customers can
 * reach. A business that has not agreed to accept cards must not appear to,
 * and a customer who presses Pay and lands on an error concludes the business
 * cannot take their money.
 */

export type PaymentSettings = {
  companyId: string
  enabled: boolean
  provider: string
  fee: FeeSchedule
  /** Where payouts land. Null means no payout can post. */
  payoutFinancialAccountId: string | null
  updatedAt: Date | null
}

const OFF: Omit<PaymentSettings, 'companyId' | 'updatedAt'> = {
  enabled: false,
  provider: 'mock',
  fee: { percentBp: 290, fixedCents: 30 },
  payoutFinancialAccountId: null,
}

/** The company's settings, or the off-by-default state. */
export async function getPaymentSettings(companyId: string): Promise<PaymentSettings> {
  const [row] = await db
    .select()
    .from(paymentSettings)
    .where(eq(paymentSettings.companyId, companyId))
    .limit(1)

  if (!row) return { companyId, ...OFF, updatedAt: null }

  return {
    companyId,
    enabled: row.enabled,
    provider: row.provider,
    fee: { percentBp: row.feePercentBp, fixedCents: Number(row.feeFixedCents) },
    payoutFinancialAccountId: row.payoutFinancialAccountId,
    updatedAt: row.updatedAt,
  }
}

export type PaymentSettingsInput = {
  enabled?: boolean
  provider?: string
  feePercentBp?: number
  feeFixedCents?: number
  payoutFinancialAccountId?: string | null
}

function validate(input: PaymentSettingsInput): void {
  if (input.feePercentBp !== undefined && (input.feePercentBp < 0 || input.feePercentBp > 2_000)) {
    throw new DomainError('A processing fee is between 0% and 20%.')
  }
  if (input.feeFixedCents !== undefined && (input.feeFixedCents < 0 || input.feeFixedCents > 10_000)) {
    throw new DomainError('A fixed fee per payment is between nothing and 100.00.')
  }
}

/**
 * Changes the settings.
 *
 * Refuses to switch on without somewhere for the money to land. Accepting a
 * card with no payout account would take a customer's money and leave the
 * business unable to post the deposit — real money against a ledger that
 * cannot record where it went.
 */
export async function updatePaymentSettings(
  ctx: ActorContext,
  input: PaymentSettingsInput,
): Promise<PaymentSettings> {
  requirePermission(ctx, 'accounting:journal')
  validate(input)

  const before = await getPaymentSettings(ctx.companyId)
  const after = {
    enabled: input.enabled ?? before.enabled,
    provider: input.provider ?? before.provider,
    feePercentBp: input.feePercentBp ?? before.fee.percentBp,
    feeFixedCents: input.feeFixedCents ?? before.fee.fixedCents,
    payoutFinancialAccountId:
      input.payoutFinancialAccountId !== undefined
        ? input.payoutFinancialAccountId
        : before.payoutFinancialAccountId,
  }

  if (after.enabled && !after.payoutFinancialAccountId) {
    throw new DomainError(
      'Choose the bank account the processor pays into before switching card payments on.',
    )
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(paymentSettings)
      .values({
        companyId: ctx.companyId,
        ...after,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: paymentSettings.companyId,
        set: { ...after, updatedBy: ctx.userId, updatedAt: new Date() },
      })

    await recordAudit(
      ctx,
      {
        action: 'payments.settings_update',
        entityType: 'payment_settings',
        entityId: null,
        before: { enabled: before.enabled, provider: before.provider },
        after: { enabled: after.enabled, provider: after.provider },
      },
      tx,
    )
  })

  return getPaymentSettings(ctx.companyId)
}
