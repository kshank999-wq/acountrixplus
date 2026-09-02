'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { requireActor, currentSession } from '@/lib/current-user'
import {
  addPracticeMember,
  assignToEngagement,
  createPractice,
  endEngagement,
  offerEngagement,
  practicesFor,
  requestEngagement,
  respondToEngagement,
  removePracticeMember,
  setEngagementStaffing,
  staffingChangePreview,
  staffingFor,
  unassignFromEngagement,
} from '@/modules/practice/service'
import { switchCompany } from '@/modules/practice/switching'
import { setPreferenceFor } from '@/modules/mobile/notifications'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies } from '@/db/schema'
import { inviteToPractice } from '@/modules/notify/invitations'
import { messageFor } from '@/modules/errors'

/** Server actions for accountant practice mode (spec §14, Phase 18). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/practice', '/settings/access', '/bookkeeping']

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

const uuid = z.string().uuid()

/**
 * Switch the firm's morning brief on or off, for the person asking (Phase 89).
 *
 * Membership is checked before the write: a practice id somebody guessed must
 * not let them write a preference row against a firm they do not work at. The
 * same gate `practiceWorkQueue` applies, for the same reason.
 */
export async function setBriefPreferenceAction(
  practiceId: unknown,
  enabled: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const id = uuid.parse(practiceId)
    const wanted = z.boolean().parse(enabled)

    const mine = await practicesFor(actor.userId)
    if (!mine.some((entry) => entry.practiceId === id)) {
      throw new Error('You do not work at that firm.')
    }

    await setPreferenceFor({ kind: 'practice', practiceId: id }, actor.userId, 'practice_brief', wanted)

    revalidatePath('/practice')
    return wanted
      ? 'You will get the firm’s morning brief again.'
      : 'You will not get the firm’s morning brief.'
  })
}

export async function switchCompanyAction(companyId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const session = await currentSession()
    if (!session) throw new Error('Sign in again.')

    const result = await switchCompany(
      {
        userId: actor.userId,
        userName: actor.userName,
        sessionId: session.sessionId,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      uuid.parse(companyId),
    )

    return `Now working in ${result.companyName}.`
  })
}

export async function createPracticeAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        name: z.string().trim().min(1, 'Give the practice a name.'),
        contactEmail: z.string().trim().email().optional().or(z.literal('')),
      })
      .parse(input)

    await createPractice({
      userId: actor.userId,
      userName: actor.userName,
      name: parsed.name,
      contactEmail: parsed.contactEmail || undefined,
    })

    return 'Practice created. Ask a client to grant you access, or request it from them.'
  })
}

export async function requestEngagementAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({ practiceId: uuid, companyId: uuid, note: z.string().trim().optional() })
      .parse(input)

    await requestEngagement(
      { userId: actor.userId, userName: actor.userName },
      { practiceId: parsed.practiceId, companyId: parsed.companyId, note: parsed.note },
    )

    return 'Requested. Nothing is granted until the company accepts — a firm cannot give itself the books.'
  })
}

export async function offerEngagementAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        practiceId: uuid,
        grantedRole: z
          .enum(['owner', 'manager', 'accountant', 'bookkeeper', 'readonly'])
          .optional(),
        note: z.string().trim().optional(),
      })
      .parse(input)

    await offerEngagement(actor, {
      practiceId: parsed.practiceId,
      grantedRole: parsed.grantedRole,
      note: parsed.note,
    })

    return 'Offered. They get access when they accept, and not before.'
  })
}

export async function respondToEngagementAction(
  engagementId: unknown,
  accept: unknown,
  side: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsedSide = z.enum(['client', 'practice']).parse(side)

    const result = await respondToEngagement(
      parsedSide === 'client'
        ? { side: 'client', ctx: actor }
        : { side: 'practice', userId: actor.userId, userName: actor.userName },
      { engagementId: uuid.parse(engagementId), accept: z.boolean().parse(accept) },
    )

    return result.status === 'active'
      ? `Accepted. ${result.membershipsGranted} ${
          result.membershipsGranted === 1 ? 'person' : 'people'
        } from the practice can now open these books.`
      : 'Declined. Nothing was granted.'
  })
}

export async function endEngagementAction(
  engagementId: unknown,
  side: unknown,
  reason?: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsedSide = z.enum(['client', 'practice']).parse(side)

    const result = await endEngagement(
      parsedSide === 'client'
        ? { side: 'client', ctx: actor }
        : { side: 'practice', userId: actor.userId, userName: actor.userName },
      {
        engagementId: uuid.parse(engagementId),
        reason: reason ? z.string().parse(reason) : undefined,
      },
    )

    return `Ended. ${result.membershipsRemoved} ${
      result.membershipsRemoved === 1 ? 'person loses' : 'people lose'
    } access on their next click, not when their session expires.`
  })
}

/**
 * Invites somebody to the firm.
 *
 * Replaces the Phase 18 version, which took a first password and set it *for*
 * them — spec §14's "never share credentials" warning in a subtler form. The
 * invitee now chooses a password nobody else has ever known, and nothing is
 * granted until they do.
 */
export async function inviteStaffAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        practiceId: uuid,
        name: z.string().trim().optional(),
        email: z.string().trim().email('That is not an email address.'),
      })
      .parse(input)

    const result = await inviteToPractice(
      { userId: actor.userId, userName: actor.userName },
      parsed,
    )

    return result.alreadyMember
      ? 'They already work here — nothing sent.'
      : `Invitation sent to ${parsed.email}. They choose their own password; you never see it.`
  })
}

export async function removePracticeMemberAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ practiceId: uuid, userId: uuid }).parse(input)

    const result = await removePracticeMember(
      { userId: actor.userId },
      { practiceId: parsed.practiceId, userId: parsed.userId },
    )

    return `Removed, and access ended at ${result.revokedAtClients} ${
      result.revokedAtClients === 1 ? 'client' : 'clients'
    } at once.`
  })
}

/** Used by the practice workspace to open a client's books. */
export async function enterClientAction(companyId: unknown): Promise<void> {
  const actor = await requireActor()
  const session = await currentSession()
  if (!session) redirect('/login')

  await switchCompany(
    {
      userId: actor.userId,
      userName: actor.userName,
      sessionId: session.sessionId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    },
    uuid.parse(companyId),
  )

  redirect('/bookkeeping')
}

// --- Who at the firm is on which client (Phase 25) ---------------------------

const ROLE = z.enum([
  'owner',
  'manager',
  'accountant',
  'bookkeeper',
  'sales',
  'marketing',
  'readonly',
])

export async function assignToEngagementAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        engagementId: uuid,
        userId: uuid,
        role: ROLE.optional().nullable(),
        note: z.string().trim().optional(),
      })
      .parse(input)

    const result = await assignToEngagement(actor.userId, {
      engagementId: parsed.engagementId,
      userId: parsed.userId,
      role: parsed.role ?? null,
      note: parsed.note ?? null,
    })

    return result.granted > 0
      ? 'On the client, and able to open their books now.'
      : 'Recorded. They already had access, because this client is staffed by the whole firm.'
  })
}

export async function unassignFromEngagementAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ engagementId: uuid, userId: uuid }).parse(input)

    const result = await unassignFromEngagement(actor.userId, parsed)

    return result.revoked > 0
      ? 'Taken off. Their access stops on their next click, not when a session expires.'
      : 'Taken off the list. They keep access while this client is staffed by the whole firm.'
  })
}

export async function setEngagementStaffingAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({ engagementId: uuid, staffing: z.enum(['whole_firm', 'assigned_only']) })
      .parse(input)

    const result = await setEngagementStaffing(actor.userId, parsed)

    if (parsed.staffing === 'assigned_only') {
      return result.revoked > 0
        ? `Only the assigned now. ${result.revoked} ${result.revoked === 1 ? 'person' : 'people'} lost access.`
        : 'Only the assigned now. Nobody lost access — everybody who had it is assigned.'
    }

    return result.granted > 0
      ? `The whole firm again. ${result.granted} ${result.granted === 1 ? 'person' : 'people'} gained access.`
      : 'The whole firm again.'
  })
}

export type StaffingView = {
  staffing: 'whole_firm' | 'assigned_only'
  companyName: string
  grantedRole: string
  staff: Array<{
    userId: string
    name: string
    email: string
    practiceRole: string
    defaultRole: string
    isAssigned: boolean
    assignedRole: string | null
    effectiveRole: string | null
    note: string | null
  }>
  /** What switching to the other mode would do, so nothing is a surprise. */
  wouldRevoke: number
  wouldGrant: number
}

/**
 * Who is on one client, loaded when somebody opens that client.
 *
 * On demand rather than with the list, the same reasoning as Phase 22's client
 * timeline: a firm with forty clients would otherwise run forty staffing
 * queries to render forty collapsed rows.
 */
export async function staffingForAction(engagementId: unknown): Promise<StaffingView | null> {
  const actor = await requireActor()

  try {
    const id = uuid.parse(engagementId)
    const { engagement, staff } = await staffingFor(id, actor.userId)

    const other = engagement.staffing === 'whole_firm' ? 'assigned_only' : 'whole_firm'
    const preview = await staffingChangePreview(id, actor.userId, other)

    const [company] = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, engagement.companyId))
      .limit(1)

    return {
      staffing: engagement.staffing,
      companyName: company?.name ?? 'This client',
      grantedRole: engagement.grantedRole,
      staff,
      wouldRevoke: preview.wouldRevoke,
      wouldGrant: preview.wouldGrant,
    }
  } catch {
    // A practice member who is not an owner, or an engagement of another firm.
    // The panel simply does not open rather than explaining what exists.
    return null
  }
}
