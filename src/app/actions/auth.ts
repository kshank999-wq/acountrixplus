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
import { companiesForUser, registerCompany } from '@/modules/tenancy/onboarding'
import { registerDevice } from '@/modules/mobile/devices'
import { industryEnum } from '@/db/schema'

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
    return { error: error instanceof Error ? error.message : 'Could not create the company.' }
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
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  // One message for both "no such user" and "wrong password", so the response
  // does not reveal which addresses are registered.
  const invalid = { error: 'That email and password combination is not recognized.' }
  if (!user) return invalid
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) return invalid

  const memberships = await companiesForUser(user.id)
  if (memberships.length === 0) {
    return { error: 'That account is not a member of any company.' }
  }

  // Every sign-in is a device, so the list on the security page is a list of
  // places this account is signed in — which is only true if it includes the
  // browser as well as the phone.
  const device = await registerDevice({
    userId: user.id,
    companyId: memberships[0].companyId,
    userAgent: (await headers()).get('user-agent'),
  })

  const { cookieValue } = await createSession(user.id, memberships[0].companyId, device.id)
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, cookieValue, sessionCookieOptions())

  // Re-checked here rather than trusted from the form: a hidden field is user
  // input, and `//evil.example` is a protocol-relative URL that a naive
  // `startsWith('/')` would happily redirect to.
  const next = parsed.data.next
  redirect(next && /^\/[^/\\]/.test(next) ? next : '/bookkeeping')
}

export async function logoutAction() {
  const cookieStore = await cookies()
  const raw = cookieStore.get(SESSION_COOKIE)?.value
  const session = await resolveSession(raw)

  if (session) await destroySession(session.sessionId)
  cookieStore.delete(SESSION_COOKIE)

  redirect('/login')
}
