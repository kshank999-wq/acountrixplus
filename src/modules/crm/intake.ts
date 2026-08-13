import { randomBytes } from 'node:crypto'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import {
  contacts,
  leadIntakeKeys,
  leadSubmissions,
  opportunities,
  opportunityActivities,
  organizations,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'

/**
 * Website lead intake (spec §6).
 *
 * This is the only unauthenticated write path in the system, so it is built
 * defensively:
 *
 *  - The public key identifies a tenant and grants *creation of a lead only*.
 *    It cannot read, update, or delete anything, and it is scoped to one
 *    company by the lookup itself.
 *  - Every field is length-capped before it reaches the database, so a large
 *    body cannot be used to bloat storage.
 *  - A honeypot field catches the most common form of automated submission.
 *  - Submissions are rate limited per key per hour, counted from the
 *    submission log rather than kept in memory, so the limit survives restarts
 *    and applies across instances.
 *  - Rejected attempts are recorded too — those are the ones worth
 *    investigating — with a ceiling so the log cannot itself be used to fill
 *    the disk.
 *  - Addresses are truncated to a network prefix rather than stored whole.
 */

/** Field caps. Generous for real submissions, far below anything abusive. */
export const leadPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional().or(z.literal('')),
  phone: z.string().trim().max(50).optional(),
  organizationName: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional(),
  /** What the visitor is asking about; becomes the opportunity title. */
  interest: z.string().trim().max(200).optional(),
  /** Explicit marketing opt-in. Absent means no consent, never implied. */
  marketingConsent: z.boolean().optional(),
  /**
   * Honeypot. Real people never see this field, so anything in it means the
   * submission was automated.
   */
  website: z.string().max(200).optional(),
})

export type LeadPayload = z.infer<typeof leadPayloadSchema>

export type IntakeMeta = {
  ip?: string | null
  userAgent?: string | null
  origin?: string | null
}

export type IntakeResult =
  | { ok: true }
  | { ok: false; status: number; reason: string; message: string }

/**
 * Truncates an address to its network prefix.
 *
 * Enough to correlate abuse from one source, not enough to identify a person
 * (spec §19 privacy).
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const first = ip.split(',')[0]!.trim()

  if (first.includes(':')) {
    // IPv6: keep the routing prefix only.
    return `${first.split(':').slice(0, 4).join(':')}::/64`
  }

  const octets = first.split('.')
  if (octets.length !== 4) return null
  return `${octets.slice(0, 3).join('.')}.0/24`
}

/** Whether an origin is permitted. An empty allowlist permits any origin. */
export function originAllowed(allowed: string[], origin: string | null | undefined): boolean {
  if (allowed.length === 0) return true
  if (!origin) return false

  return allowed.some((entry) => {
    const normalized = entry.trim().replace(/\/$/, '').toLowerCase()
    return normalized === origin.replace(/\/$/, '').toLowerCase()
  })
}

/**
 * Accepts a lead from a public form.
 *
 * Returns a discriminated result rather than throwing, because the caller is
 * an HTTP route that must not leak internal errors to an anonymous client.
 * Failure messages are deliberately vague about *why* beyond the category.
 */
export async function submitLead(
  publicKey: string,
  payload: unknown,
  meta: IntakeMeta = {},
): Promise<IntakeResult> {
  const [key] = await db
    .select()
    .from(leadIntakeKeys)
    .where(and(eq(leadIntakeKeys.publicKey, publicKey), eq(leadIntakeKeys.isActive, true)))
    .limit(1)

  // Same response for an unknown key and a revoked one — probing should not
  // reveal which keys exist.
  if (!key) {
    return { ok: false, status: 404, reason: 'unknown_key', message: 'Unknown intake key.' }
  }

  const ipPrefix = truncateIp(meta.ip)
  const log = async (accepted: boolean, rejectionReason?: string, opportunityId?: string) => {
    await recordSubmission(key, {
      accepted,
      rejectionReason,
      ipPrefix,
      userAgent: meta.userAgent,
      origin: meta.origin,
      opportunityId,
    })
  }

  if (!originAllowed(key.allowedOrigins, meta.origin)) {
    await log(false, 'origin')
    return { ok: false, status: 403, reason: 'origin', message: 'Origin not permitted.' }
  }

  if (await isRateLimited(key)) {
    await log(false, 'rate_limited')
    return {
      ok: false,
      status: 429,
      reason: 'rate_limited',
      message: 'Too many submissions. Try again later.',
    }
  }

  const parsed = leadPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    await log(false, 'invalid')
    return {
      ok: false,
      status: 400,
      reason: 'invalid',
      message: 'Please check the form and try again.',
    }
  }

  // Honeypot: a real visitor never fills a field they cannot see.
  if (parsed.data.website && parsed.data.website.trim() !== '') {
    await log(false, 'honeypot')
    // Reported as success so an automated submitter learns nothing.
    return { ok: true }
  }

  const lead = parsed.data
  const opportunityId = await createLeadRecords(key.companyId, lead, meta)
  await log(true, undefined, opportunityId)

  await db
    .update(leadIntakeKeys)
    .set({
      lastUsedAt: new Date(),
      submissionCount: sql`${leadIntakeKeys.submissionCount} + 1`,
    })
    .where(eq(leadIntakeKeys.id, key.id))

  return { ok: true }
}

/** Creates the organization, contact, and opportunity for an accepted lead. */
async function createLeadRecords(
  companyId: string,
  lead: LeadPayload,
  meta: IntakeMeta,
): Promise<string> {
  const organizationName = lead.organizationName?.trim() || lead.name

  return db.transaction(async (tx) => {
    // Reuse an existing organization with the same name rather than creating a
    // duplicate each time someone submits the form twice.
    const [existing] = await tx
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.companyId, companyId),
          sql`lower(${organizations.name}) = lower(${organizationName})`,
        ),
      )
      .limit(1)

    const organization =
      existing ??
      (
        await tx
          .insert(organizations)
          .values({
            companyId,
            name: organizationName,
            lifecycleStage: 'lead',
            email: lead.email || null,
            phone: lead.phone ?? null,
            source: 'website',
          })
          .returning()
      )[0]

    const [firstName, ...rest] = lead.name.split(' ')
    const [contact] = await tx
      .insert(contacts)
      .values({
        companyId,
        organizationId: organization.id,
        firstName: firstName ?? null,
        lastName: rest.join(' ') || null,
        email: lead.email || null,
        phone: lead.phone ?? null,
        isPrimary: !existing,
        // Consent only when explicitly given on the form.
        emailConsent: lead.marketingConsent ? 'subscribed' : 'unknown',
        consentSource: lead.marketingConsent ? 'website_intake' : null,
        consentAt: lead.marketingConsent ? new Date() : null,
      })
      .returning()

    const [opportunity] = await tx
      .insert(opportunities)
      .values({
        companyId,
        organizationId: organization.id,
        primaryContactId: contact.id,
        title: lead.interest?.trim() || `Website inquiry from ${lead.name}`,
        stage: 'new_inquiry',
        source: 'website',
        probability: 10,
        notes: lead.message ?? null,
      })
      .returning()

    // The submission itself is the first entry in the sales history. There is
    // no acting user, so the actor is recorded as the website.
    await tx.insert(opportunityActivities).values({
      companyId,
      opportunityId: opportunity.id,
      kind: 'lead_intake',
      summary: `Website inquiry from ${lead.name}`,
      detail: {
        email: lead.email || null,
        phone: lead.phone ?? null,
        message: lead.message ?? null,
        origin: meta.origin ?? null,
      },
      actorName: 'Website intake',
    })

    return opportunity.id
  })
}

/**
 * Whether this key has exceeded its hourly allowance.
 *
 * Counts accepted submissions only, so a burst of rejected junk cannot lock a
 * legitimate visitor out of a form.
 */
async function isRateLimited(key: typeof leadIntakeKeys.$inferSelect): Promise<boolean> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000)

  const [row] = await db
    .select({ total: sql<string>`count(*)` })
    .from(leadSubmissions)
    .where(
      and(
        eq(leadSubmissions.intakeKeyId, key.id),
        eq(leadSubmissions.accepted, true),
        gte(leadSubmissions.receivedAt, windowStart),
      ),
    )

  return Number(row?.total ?? 0) >= key.hourlyLimit
}

/**
 * Appends to the submission log.
 *
 * Rejected attempts are recorded because those are the ones worth
 * investigating — but with a ceiling, so an attacker cannot use the log itself
 * to exhaust storage. Past the ceiling the request is still refused; it just
 * stops being written down.
 */
async function recordSubmission(
  key: typeof leadIntakeKeys.$inferSelect,
  input: {
    accepted: boolean
    rejectionReason?: string
    ipPrefix: string | null
    userAgent?: string | null
    origin?: string | null
    opportunityId?: string
  },
) {
  if (!input.accepted) {
    const windowStart = new Date(Date.now() - 60 * 60 * 1000)
    const [row] = await db
      .select({ total: sql<string>`count(*)` })
      .from(leadSubmissions)
      .where(
        and(
          eq(leadSubmissions.intakeKeyId, key.id),
          gte(leadSubmissions.receivedAt, windowStart),
        ),
      )

    // Ten times the hourly allowance is plenty of evidence.
    if (Number(row?.total ?? 0) >= key.hourlyLimit * 10) return
  }

  await db.insert(leadSubmissions).values({
    companyId: key.companyId,
    intakeKeyId: key.id,
    accepted: input.accepted,
    rejectionReason: input.rejectionReason ?? null,
    ipPrefix: input.ipPrefix,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
    origin: input.origin?.slice(0, 200) ?? null,
    createdOpportunityId: input.opportunityId ?? null,
  })
}

// --- Key management (authenticated) ---------------------------------------

export async function createIntakeKey(
  ctx: ActorContext,
  input: { name: string; allowedOrigins?: string[]; hourlyLimit?: number },
) {
  requirePermission(ctx, 'crm:manage')

  return db.transaction(async (tx) => {
    const [key] = await tx
      .insert(leadIntakeKeys)
      .values({
        companyId: ctx.companyId,
        publicKey: `pk_${randomBytes(18).toString('base64url')}`,
        name: input.name,
        allowedOrigins: input.allowedOrigins ?? [],
        hourlyLimit: input.hourlyLimit ?? 60,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'intake_key.create',
        entityType: 'lead_intake_key',
        entityId: key.id,
        after: { name: key.name, allowedOrigins: key.allowedOrigins },
      },
      tx,
    )

    return key
  })
}

export async function revokeIntakeKey(ctx: ActorContext, keyId: string) {
  requirePermission(ctx, 'crm:manage')

  await db.transaction(async (tx) => {
    await tx
      .update(leadIntakeKeys)
      .set({ isActive: false })
      .where(
        and(eq(leadIntakeKeys.id, keyId), eq(leadIntakeKeys.companyId, ctx.companyId)),
      )

    await recordAudit(
      ctx,
      {
        action: 'intake_key.revoke',
        entityType: 'lead_intake_key',
        entityId: keyId,
        after: { isActive: false },
      },
      tx,
    )
  })
}

export async function listIntakeKeys(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(leadIntakeKeys)
    .where(scoped(ctx, leadIntakeKeys))
    .orderBy(desc(leadIntakeKeys.createdAt))
}

/** Recent intake attempts, for spotting abuse against a public endpoint. */
export async function recentSubmissions(ctx: ActorContext, limit = 50) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(leadSubmissions)
    .where(scoped(ctx, leadSubmissions))
    .orderBy(desc(leadSubmissions.receivedAt))
    .limit(limit)
}
