'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import { users } from '@/db/schema'
import { verifyPassword } from '@/modules/auth/password'
import {
  createSession,
  destroySession,
  resolveSession,
  sessionCookieOptions,
  SESSION_COOKIE,
} from '@/modules/auth/session'
import {
  CHALLENGE_COOKIE,
  challengeCookieOptions,
  challengeSubject,
  issueChallenge,
  readChallenge,
} from '@/modules/auth/challenge'
import { hasConfirmedMfa, verifyChallenge } from '@/modules/auth/mfa'
import { requestAddressChange } from '@/modules/notify/email-change'
import { requireActor, requireSession } from '@/lib/current-user'
import { lockoutState, recordLoginAttempt } from '@/modules/auth/login-history'
import { companiesForUser, registerCompany } from '@/modules/tenancy/onboarding'
import { registerDevice } from '@/modules/mobile/devices'
import { industryEnum } from '@/db/schema'
import { messageFor } from '@/modules/errors'

export type FormState = { error?: string } | null

const registerSchema = z.object({
  companyName: z.string().min(1, 'Company name is required.'),
  industry: z.enum(industryEnum.enumValues),
  userName: z.string().min(1, 'Your name is required.'),
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
})

/** Onboarding: create the company, its owner, and its chart of accounts. */
export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = registerSchema.safeParse({
    companyName: formData.get('companyName'),
    industry: formData.get('industry'),
    userName: formData.get('userName'),
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' }
  }

  let companyId: string
  let userId: string
  try {
    const result = await registerCompany(parsed.data)
    companyId = result.company.id
    userId = result.user.id
  } catch (error) {
    return { error: messageFor(error, 'Could not create the company.') }
  }

  const device = await registerDevice({
    userId,
    companyId,
    userAgent: (await headers()).get('user-agent'),
  })

  const { cookieValue } = await createSession(userId, companyId, device.id)
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, cookieValue, sessionCookieOptions())

  redirect('/bookkeeping')
}

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
  /** Where to land afterwards. Same-origin paths only — see below. */
  next: z.string().optional(),
})

/**
 * Step one: the password.
 *
 * The sequence matters and is worth reading in order — lockout, then password,
 * then second factor. Checking the password first and the lockout afterwards
 * would make the lockout decorative, since the attacker has already learned
 * whether the password was right.
 */
export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' }
  }

  const email = parsed.data.email.trim().toLowerCase()
  const requestHeaders = await headers()
  const ip = requestHeaders.get('x-forwarded-for') ?? requestHeaders.get('x-real-ip')
  const userAgent = requestHeaders.get('user-agent')

  const lockout = await lockoutState(email)
  if (lockout.locked) {
    await recordLoginAttempt({ email, outcome: 'locked_out', ip, userAgent })
    return {
      error:
        'Too many failed attempts for this address. Try again in a few minutes, or reset your password.',
    }
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  // One message for both "no such user" and "wrong password", so the response
  // does not reveal which addresses are registered. The *record* distinguishes
  // them, because "somebody is trying addresses that are not ours" and
  // "somebody is guessing one person's password" are different problems.
  const invalid = { error: 'That email and password combination is not recognized.' }

  if (!user) {
    await recordLoginAttempt({ email, outcome: 'unknown_email', ip, userAgent })
    return invalid
  }

  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    await recordLoginAttempt({ email, userId: user.id, outcome: 'wrong_password', ip, userAgent })
    return invalid
  }

  const memberships = await companiesForUser(user.id)
  if (memberships.length === 0) {
    await recordLoginAttempt({ email, userId: user.id, outcome: 'no_membership', ip, userAgent })
    return { error: 'That account is not a member of any company.' }
  }

  // The password was right. If there is a second factor, stop here — with a
  // token that grants nothing except the right to present one.
  if (await hasConfirmedMfa(user.id)) {
    await recordLoginAttempt({ email, userId: user.id, outcome: 'mfa_required', ip, userAgent })

    const cookieStore = await cookies()
    cookieStore.set(
      CHALLENGE_COOKIE,
      issueChallenge({ userId: user.id, passwordHash: user.passwordHash }),
      challengeCookieOptions(),
    )

    const next = safeNext(parsed.data.next)
    redirect(`/login/verify?next=${encodeURIComponent(next)}`)
  }

  await recordLoginAttempt({ email, userId: user.id, outcome: 'success', ip, userAgent })
  await establishSession(user.id, memberships[0].companyId, userAgent)

  redirect(safeNext(parsed.data.next))
}

const verifySchema = z.object({
  code: z.string().min(1, 'Enter the code from your authenticator app.'),
  next: z.string().optional(),
})

/**
 * Step two: the second factor.
 *
 * Runs its own lockout check. Without one, an attacker holding a stolen
 * password gets unlimited guesses at a six-digit code — which is the whole of
 * the protection MFA was added for.
 */
export async function verifyMfaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = verifySchema.safeParse({
    code: formData.get('code'),
    next: formData.get('next') ?? undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' }
  }

  const cookieStore = await cookies()
  const token = cookieStore.get(CHALLENGE_COOKIE)?.value

  const subject = challengeSubject(token)
  const expired = { error: 'That sign-in attempt has expired. Please start again.' }
  if (!subject) return expired

  const [user] = await db.select().from(users).where(eq(users.id, subject)).limit(1)
  if (!user) return expired

  // Validated only now: the signature is over the password hash, which cannot
  // be fetched until the token has named a user.
  if (!readChallenge(token, { passwordHash: user.passwordHash })) return expired

  const requestHeaders = await headers()
  const ip = requestHeaders.get('x-forwarded-for') ?? requestHeaders.get('x-real-ip')
  const userAgent = requestHeaders.get('user-agent')

  const lockout = await lockoutState(user.email)
  if (lockout.locked) {
    await recordLoginAttempt({ email: user.email, userId: user.id, outcome: 'locked_out', ip, userAgent })
    return { error: 'Too many failed attempts. Try again in a few minutes.' }
  }

  const result = await verifyChallenge(user.id, parsed.data.code)

  if (!result.ok) {
    await recordLoginAttempt({
      email: user.email,
      userId: user.id,
      // Recorded apart from a wrong code on purpose: a *reused* code means
      // somebody else saw one, which is a different and worse event.
      outcome: result.reason === 'already_used' ? 'reused_mfa_code' : 'wrong_mfa_code',
      ip,
      userAgent,
    })

    return {
      error:
        result.reason === 'already_used'
          ? 'That code has already been used. Wait for the next one.'
          : 'That code is not right. Check your authenticator app, or use a recovery code.',
    }
  }

  const memberships = await companiesForUser(user.id)
  if (memberships.length === 0) return { error: 'That account is not a member of any company.' }

  await recordLoginAttempt({ email: user.email, userId: user.id, outcome: 'success', ip, userAgent })

  cookieStore.delete(CHALLENGE_COOKIE)
  await establishSession(user.id, memberships[0].companyId, userAgent)

  redirect(safeNext(parsed.data.next))
}

/**
 * Registers the device and sets the session cookie.
 *
 * Every sign-in is a device, so the list on the security page is a list of
 * places this account is signed in — which is only true if it includes the
 * browser as well as the phone.
 */
async function establishSession(
  userId: string,
  companyId: string,
  userAgent: string | null,
): Promise<void> {
  const device = await registerDevice({ userId, companyId, userAgent })
  const { cookieValue } = await createSession(userId, companyId, device.id)

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, cookieValue, sessionCookieOptions())
}

/**
 * Where to land afterwards.
 *
 * Re-checked rather than trusted from the form: a hidden field is user input,
 * and `//evil.example` is a protocol-relative URL that a naive
 * `startsWith('/')` would happily redirect to.
 */
function safeNext(next: string | undefined): string {
  return next && /^\/[^/\\]/.test(next) ? next : '/bookkeeping'
}

export async function logoutAction() {
  const cookieStore = await cookies()
  const raw = cookieStore.get(SESSION_COOKIE)?.value
  const session = await resolveSession(raw)

  if (session) await destroySession(session.sessionId)
  cookieStore.delete(SESSION_COOKIE)

  redirect('/login')
}

/**
 * Claims a new sign-in address (Phase 98).
 *
 * The refusal text comes from the core, so what somebody reads when they are
 * stopped is the sentence that decided it. An accepted claim says the same
 * thing whether or not the address belongs to somebody else — see
 * `requestAddressChange`, and `requestPasswordReset` before it.
 */
export async function requestAddressChangeAction(
  input: unknown,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    const actor = await requireActor()
    const session = await requireSession()
    const parsed = z
      .object({ requested: z.string(), currentPassword: z.string() })
      .parse(input)

    const result = await requestAddressChange(actor, {
      requested: parsed.requested,
      companyName: session.companyName,
      currentPassword: parsed.currentPassword,
    })

    if (!result.accepted) return { ok: false, error: result.error }

    return {
      ok: true,
      message:
        'Check the new address for a link. Nothing changes until you open it, and the address ' +
        'you use now has been told.',
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Could not start that change.') }
  }
}
