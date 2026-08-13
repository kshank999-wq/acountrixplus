'use server'

import { cookies } from 'next/headers'
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

  const { cookieValue } = await createSession(userId, companyId)
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, cookieValue, sessionCookieOptions())

  redirect('/bookkeeping')
}

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
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

  const { cookieValue } = await createSession(user.id, memberships[0].companyId)
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, cookieValue, sessionCookieOptions())

  redirect('/bookkeeping')
}

export async function logoutAction() {
  const cookieStore = await cookies()
  const raw = cookieStore.get(SESSION_COOKIE)?.value
  const session = await resolveSession(raw)

  if (session) await destroySession(session.sessionId)
  cookieStore.delete(SESSION_COOKIE)

  redirect('/login')
}
