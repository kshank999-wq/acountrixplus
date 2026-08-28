import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { chaseSettings } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DomainError } from '@/modules/errors'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { DEFAULT_CHASE_POLICY, type ChasePolicy } from './chasing'

/**
 * The chase policy as a row somebody owns (spec §13, §24).
 *
 * The cadence is not a fact about accounting. A builder chasing a homeowner
 * for £400 and a wholesaler chasing a chain for £40,000 want different
 * letters at different intervals, and neither of them should have to change a
 * deployment to say so. So the numbers live in a table.
 *
 * ## Absent means off, deliberately
 *
 * `getChasePolicy` returns the disabled default when there is no row, which is
 * the same shape `modules/ai/settings.ts` uses and for a stronger reason. This
 * is the only automatic behaviour in the system that sends email to somebody
 * who is not a user of it, over a company's own name, with nobody present. A
 * feature that starts doing that because a migration ran is one nobody agreed
 * to. There is no backfill; every company begins silent and stays that way
 * until a person turns it on.
 */

export type ChaseSettings = ChasePolicy & {
  companyId: string
  /**
   * A ceiling on one run. Not a rate limit — Phase 42 has one of those, per
   * address. This is a guard against the accident that happens exactly once:
   * chasing switched on for the first time with four years of unpaid invoices
   * behind it, and every customer the company has ever had emailed at 08:00.
   */
  maxPerRun: number
  updatedAt: Date | null
}

const OFF: Omit<ChaseSettings, 'companyId' | 'updatedAt'> = {
  ...DEFAULT_CHASE_POLICY,
  maxPerRun: 50,
}

/** This company's policy, or the off-by-default one. */
export async function getChasePolicy(companyId: string): Promise<ChaseSettings> {
  const [row] = await db
    .select()
    .from(chaseSettings)
    .where(eq(chaseSettings.companyId, companyId))
    .limit(1)

  if (!row) return { companyId, ...OFF, updatedAt: null }

  return {
    companyId,
    enabled: row.enabled,
    firstAfterDays: row.firstAfterDays,
    everyDays: row.everyDays,
    maxChases: row.maxChases,
    minimumBalanceCents: Number(row.minimumBalanceCents),
    quietDaysAfterPayment: row.quietDaysAfterPayment,
    maxPerRun: row.maxPerRun,
    updatedAt: row.updatedAt,
  }
}

export type ChasePolicyInput = Partial<Omit<ChaseSettings, 'companyId' | 'updatedAt'>>

/**
 * The bounds a policy has to stay inside.
 *
 * Not opinions about good practice — each one names a setting that would make
 * the machine do something a person would not choose on purpose. Chasing
 * before the money is late is a different letter; chasing every day gets the
 * sender blocked; chasing for ever ends a relationship by automation.
 */
function validate(input: ChasePolicyInput): void {
  if (input.firstAfterDays !== undefined && input.firstAfterDays < 0) {
    throw new DomainError('The first chase cannot go out before the invoice is due.')
  }
  if (input.everyDays !== undefined && input.everyDays < 1) {
    throw new DomainError('Leave at least a day between chases.')
  }
  if (input.maxChases !== undefined && (input.maxChases < 1 || input.maxChases > 12)) {
    throw new DomainError('An invoice gets between one and twelve chases.')
  }
  if (input.minimumBalanceCents !== undefined && input.minimumBalanceCents < 0) {
    throw new DomainError('A minimum balance cannot be negative.')
  }
  if (input.quietDaysAfterPayment !== undefined && input.quietDaysAfterPayment < 0) {
    throw new DomainError('Days of quiet after a payment cannot be negative.')
  }
  if (input.maxPerRun !== undefined && (input.maxPerRun < 1 || input.maxPerRun > 500)) {
    throw new DomainError('A run sends between one and five hundred chases.')
  }
}

/**
 * Changes the policy.
 *
 * Gated on `accounting:journal` — the same permission `sendInvoice` requires,
 * because switching this on is deciding that invoices will be sent without
 * anybody deciding again. Audited for the same reason: "why did our customer
 * get three emails" has an answer somebody can find.
 */
export async function updateChasePolicy(
  ctx: ActorContext,
  input: ChasePolicyInput,
): Promise<ChaseSettings> {
  requirePermission(ctx, 'accounting:journal')
  validate(input)

  const before = await getChasePolicy(ctx.companyId)
  const after = { ...before, ...input }

  await db.transaction(async (tx) => {
    await tx
      .insert(chaseSettings)
      .values({
        companyId: ctx.companyId,
        enabled: after.enabled,
        firstAfterDays: after.firstAfterDays,
        everyDays: after.everyDays,
        maxChases: after.maxChases,
        minimumBalanceCents: after.minimumBalanceCents,
        quietDaysAfterPayment: after.quietDaysAfterPayment,
        maxPerRun: after.maxPerRun,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: chaseSettings.companyId,
        set: {
          enabled: after.enabled,
          firstAfterDays: after.firstAfterDays,
          everyDays: after.everyDays,
          maxChases: after.maxChases,
          minimumBalanceCents: after.minimumBalanceCents,
          quietDaysAfterPayment: after.quietDaysAfterPayment,
          maxPerRun: after.maxPerRun,
          updatedBy: ctx.userId,
          updatedAt: new Date(),
        },
      })

    await recordAudit(
      ctx,
      {
        action: 'chase.settings_update',
        entityType: 'chase_settings',
        entityId: null,
        before: { enabled: before.enabled, everyDays: before.everyDays, maxChases: before.maxChases },
        after: { enabled: after.enabled, everyDays: after.everyDays, maxChases: after.maxChases },
      },
      tx,
    )
  })

  return getChasePolicy(ctx.companyId)
}
