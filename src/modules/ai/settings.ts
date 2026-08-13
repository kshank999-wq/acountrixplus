import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/db'
import { aiRequests, aiSettings } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { getAiProvider } from './registry'

/**
 * Module configuration, quotas, and cost ceilings (spec §11, §12).
 *
 * The default matters more than anything else in this file: a company with no
 * settings row has AI **off**. Spec §23 requires the core product to work
 * without AI, and the way to guarantee that is for the switched-off state to
 * be the one you get by doing nothing.
 */

export type AiSettings = {
  companyId: string
  enabled: boolean
  provider: string
  model: string
  monthlyCeilingMicros: number
  hourlyRequestLimit: number
  disabledFeatures: string[]
}

const OFF: Omit<AiSettings, 'companyId'> = {
  enabled: false,
  provider: 'mock',
  model: '',
  monthlyCeilingMicros: 2_000_000,
  hourlyRequestLimit: 120,
  disabledFeatures: [],
}

/** The company's settings, or the off-by-default state. */
export async function getSettings(companyId: string): Promise<AiSettings> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.companyId, companyId)).limit(1)

  if (!row) return { companyId, ...OFF }

  return {
    companyId,
    enabled: row.enabled,
    provider: row.provider,
    model: row.model,
    monthlyCeilingMicros: Number(row.monthlyCeilingMicros),
    hourlyRequestLimit: row.hourlyRequestLimit,
    disabledFeatures: row.disabledFeatures ?? [],
  }
}

export async function updateSettings(
  ctx: ActorContext,
  input: Partial<Omit<AiSettings, 'companyId'>>,
): Promise<AiSettings> {
  requirePermission(ctx, 'ai:manage')

  if (input.monthlyCeilingMicros !== undefined && input.monthlyCeilingMicros < 0) {
    throw new Error('A spend ceiling cannot be negative.')
  }
  if (input.hourlyRequestLimit !== undefined && input.hourlyRequestLimit < 1) {
    throw new Error('The hourly limit must allow at least one request.')
  }

  const before = await getSettings(ctx.companyId)

  await db.transaction(async (tx) => {
    await tx
      .insert(aiSettings)
      .values({
        companyId: ctx.companyId,
        enabled: input.enabled ?? before.enabled,
        provider: input.provider ?? before.provider,
        model: input.model ?? before.model,
        monthlyCeilingMicros: input.monthlyCeilingMicros ?? before.monthlyCeilingMicros,
        hourlyRequestLimit: input.hourlyRequestLimit ?? before.hourlyRequestLimit,
        disabledFeatures: input.disabledFeatures ?? before.disabledFeatures,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: aiSettings.companyId,
        set: {
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.monthlyCeilingMicros !== undefined
            ? { monthlyCeilingMicros: input.monthlyCeilingMicros }
            : {}),
          ...(input.hourlyRequestLimit !== undefined
            ? { hourlyRequestLimit: input.hourlyRequestLimit }
            : {}),
          ...(input.disabledFeatures !== undefined
            ? { disabledFeatures: input.disabledFeatures }
            : {}),
          updatedBy: ctx.userId,
          updatedAt: new Date(),
        },
      })

    // Turning the module on or off is a company-level change somebody should
    // be able to find later, so it is audited like any other.
    await recordAudit(
      ctx,
      {
        action: 'ai.settings_update',
        entityType: 'ai_settings',
        entityId: null,
        before: { enabled: before.enabled, provider: before.provider },
        after: {
          enabled: input.enabled ?? before.enabled,
          provider: input.provider ?? before.provider,
        },
      },
      tx,
    )
  })

  return getSettings(ctx.companyId)
}

// --- Metering --------------------------------------------------------------

export type UsageWindow = {
  /** Spend so far this calendar month, in millionths of a dollar. */
  monthMicros: number
  monthRequests: number
  hourRequests: number
}

function startOfMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** What has been spent and how many calls have been made (spec §12). */
export async function usageWindow(companyId: string): Promise<UsageWindow> {
  const hourAgo = new Date(Date.now() - 3_600_000)

  const [month] = await db
    .select({
      micros: sql<string>`coalesce(sum(${aiRequests.costMicros}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(aiRequests)
    .where(and(eq(aiRequests.companyId, companyId), gte(aiRequests.createdAt, startOfMonth())))

  const [hour] = await db
    .select({ count: sql<string>`count(*)` })
    .from(aiRequests)
    .where(and(eq(aiRequests.companyId, companyId), gte(aiRequests.createdAt, hourAgo)))

  return {
    monthMicros: Number(month?.micros ?? 0),
    monthRequests: Number(month?.count ?? 0),
    hourRequests: Number(hour?.count ?? 0),
  }
}

export type GateResult =
  | { allowed: true; settings: AiSettings }
  | { allowed: false; reason: 'disabled' | 'feature_disabled' | 'ceiling' | 'rate_limit'; message: string }

/**
 * Whether a call may proceed.
 *
 * Checked before a provider is reached, never after — a ceiling enforced after
 * the money is spent is not a ceiling. The messages are written for the person
 * who will read them in the UI, not for a log.
 */
export async function checkGate(companyId: string, feature: string): Promise<GateResult> {
  const settings = await getSettings(companyId)

  if (!settings.enabled) {
    return {
      allowed: false,
      reason: 'disabled',
      message: 'The AI module is switched off for this company.',
    }
  }

  if (settings.disabledFeatures.includes(feature)) {
    return {
      allowed: false,
      reason: 'feature_disabled',
      message: 'That assistant has been switched off for this company.',
    }
  }

  const usage = await usageWindow(companyId)

  if (settings.monthlyCeilingMicros > 0 && usage.monthMicros >= settings.monthlyCeilingMicros) {
    return {
      allowed: false,
      reason: 'ceiling',
      message: `This month's AI spend ceiling has been reached. Raise it in settings, or wait for the new month.`,
    }
  }

  if (usage.hourRequests >= settings.hourlyRequestLimit) {
    return {
      allowed: false,
      reason: 'rate_limit',
      message: 'Too many AI requests in the last hour. Try again shortly.',
    }
  }

  return { allowed: true, settings }
}

/**
 * Whether the module is usable at all, for deciding what UI to render.
 *
 * A workspace should not show a disabled assistant button — spec §23 says AI
 * is additive, and an affordance that is always greyed out is not additive,
 * it is clutter.
 */
export async function aiAvailable(ctx: ActorContext): Promise<boolean> {
  if (!ctx.role) return false

  const settings = await getSettings(ctx.companyId)
  return settings.enabled
}

/** Provider health for the admin page: is the selected adapter usable? */
export async function providerHealth(companyId: string) {
  const settings = await getSettings(companyId)
  const resolved = getAiProvider(settings.provider)

  return {
    selected: settings.provider,
    /** What will actually run — the mock, if the selection has no key. */
    effective: resolved.key,
    fellBack: resolved.key !== settings.provider,
    model: settings.model || resolved.defaultModel,
  }
}

/** Ledger rows for the admin page, newest first. */
export async function recentRequests(ctx: ActorContext, limit = 50) {
  requirePermission(ctx, 'ai:manage')

  return db
    .select()
    .from(aiRequests)
    .where(scoped(ctx, aiRequests))
    .orderBy(sql`${aiRequests.createdAt} desc`)
    .limit(limit)
}

/** Spend and volume by feature, for the admin page (spec §12 metering). */
export async function usageByFeature(ctx: ActorContext) {
  requirePermission(ctx, 'ai:manage')

  return db
    .select({
      feature: aiRequests.feature,
      requests: sql<string>`count(*)`,
      micros: sql<string>`coalesce(sum(${aiRequests.costMicros}), 0)`,
      failures: sql<string>`count(*) FILTER (WHERE ${aiRequests.outcome} <> 'ok')`,
      avgLatencyMs: sql<string>`coalesce(round(avg(${aiRequests.latencyMs})), 0)`,
    })
    .from(aiRequests)
    .where(scoped(ctx, aiRequests, gte(aiRequests.createdAt, startOfMonth())))
    .groupBy(aiRequests.feature)
}
