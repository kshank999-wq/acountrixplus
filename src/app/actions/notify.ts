'use server'

import { revalidatePath } from 'next/cache'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  completePasswordReset,
  requestPasswordReset,
} from '@/modules/notify/password-reset'
import {
  acceptInvitation,
  inviteToCompany,
  inviteToPractice,
  withdrawCompanyInvitation,
} from '@/modules/notify/invitations'
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '@/modules/auth/session'
import { practicesFor } from '@/modules/practice/service'
import { reachableCompanies } from '@/modules/practice/switching'
import { messageFor } from '@/modules/errors'

/** Server actions for password reset and invitations (spec §19, Phase 19). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function requestMeta() {
  const headerStore = await headers()
  return {
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  }
}

/**
 * "I forgot my password."
 *
 * Says the same thing whether or not the address exists. A form that reports
 * "no account with that email" is a way to find out who banks here, one
 * address at a time.
 */
export async function requestResetAction(email: unknown): Promise<ActionResult> {
  const parsed = z.string().trim().min(1, 'Type the email address you sign in with.').safeParse(email)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const meta = await requestMeta()
  await requestPasswordReset({ email: parsed.data, ipAddress: meta.ipAddress })

  return {
    ok: true,
    message:
      'If that address has an account, a link is on its way. It works once and expires in an hour.',
  }
}

export async function completeResetAction(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      token: z.string().min(1),
      password: z.string().min(8, 'A password must be at least 8 characters.'),
    })
    .safeParse(input)

  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const meta = await requestMeta()
  const result = await completePasswordReset({
    token: parsed.data.token,
    newPassword: parsed.data.password,
    ...meta,
  })

  if (!result.ok) return { ok: false, error: result.error }

  return {
    ok: true,
    message:
      result.sessionsEnded > 0
        ? `Password changed, and ${result.sessionsEnded} other ${
            result.sessionsEnded === 1 ? 'session was' : 'sessions were'
          } signed out. Sign in with the new one.`
        : 'Password changed. Sign in with the new one.',
  }
}

const inviteSchema = z.object({
  email: z.string().trim().email('That is not an email address.'),
  name: z.string().trim().optional(),
  role: z.enum(['owner', 'manager', 'bookkeeper', 'accountant', 'sales', 'marketing', 'readonly']),
})

export async function inviteToCompanyAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = inviteSchema.parse(input)

    const result = await inviteToCompany(actor, parsed)
    revalidatePath('/settings/access')

    return {
      ok: true,
      message: result.alreadyMember
        ? 'They are already on these books — nothing sent.'
        : `Invitation sent to ${parsed.email}. They choose their own password; you never see it.`,
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

export async function withdrawInvitationAction(tokenId: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const done = await withdrawCompanyInvitation(actor, z.string().uuid().parse(tokenId))
    revalidatePath('/settings/access')

    return done
      ? { ok: true, message: 'Withdrawn. That link no longer works.' }
      : { ok: false, error: 'That invitation has already been accepted or withdrawn.' }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

export async function inviteToPracticeAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = z
      .object({
        practiceId: z.string().uuid(),
        email: z.string().trim().email('That is not an email address.'),
        name: z.string().trim().optional(),
      })
      .parse(input)

    const result = await inviteToPractice(
      { userId: actor.userId, userName: actor.userName },
      parsed,
    )
    revalidatePath('/practice')

    return {
      ok: true,
      message: result.alreadyMember
        ? 'They already work here — nothing sent.'
        : `Invitation sent to ${parsed.email}. They choose their own password.`,
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

/**
 * Accepts an invitation and signs the person in.
 *
 * Signing in immediately is deliberate: somebody who has just proved they own
 * the address and chosen a password should not then be shown a login form, and
 * making them type the password they set ten seconds ago teaches them nothing
 * except that the software does not trust its own flow.
 */
export async function acceptInvitationAction(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      token: z.string().min(1),
      password: z.string().optional(),
      name: z.string().trim().optional(),
    })
    .safeParse(input)

  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const result = await acceptInvitation(parsed.data)
  if (!result.ok) return { ok: false, error: result.error }

  // The company to land in: the one just joined, or — for a practice
  // invitation — whichever client the firm already serves. A practice member
  // with no clients yet has no company at all, which the practice workspace
  // handles.
  const reachable = await reachableCompanies(result.userId, null)
  const landing = result.companyId ?? reachable[0]?.id ?? null

  const { cookieValue } = await createSession(result.userId, landing)
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, cookieValue, sessionCookieOptions())

  if (!landing) {
    const practices = await practicesFor(result.userId)
    if (practices.length > 0) redirect('/practice')
  }

  redirect(landing ? '/bookkeeping' : '/practice')
}
