'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { requireActor, currentSession } from '@/lib/current-user'
import {
  addPracticeMember,
  createPractice,
  endEngagement,
  offerEngagement,
  requestEngagement,
  respondToEngagement,
  removePracticeMember,
} from '@/modules/practice/service'
import { switchCompany } from '@/modules/practice/switching'
import { inviteToPractice } from '@/modules/notify/invitations'

/** Server actions for accountant practice mode (spec §14, Phase 18). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/practice', '/settings/access', '/bookkeeping']

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

const uuid = z.string().uuid()

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
