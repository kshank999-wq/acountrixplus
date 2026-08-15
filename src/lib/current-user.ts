import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { resolveSession, SESSION_COOKIE } from '@/modules/auth/session'
import { securityPolicy } from '@/modules/auth/login-history'
import { hasConfirmedMfa } from '@/modules/auth/mfa'
import type { ActorContext } from '@/modules/tenancy/context'

/**
 * Resolves the acting user for the current request.
 *
 * Every page and server action starts here, which is what guarantees no
 * request reaches a service without a tenant-scoped context (spec §19).
 */
export async function currentActor(): Promise<ActorContext | null> {
  const cookieStore = await cookies()
  const session = await resolveSession(cookieStore.get(SESSION_COOKIE)?.value)
  if (!session) return null

  const headerStore = await headers()

  return {
    userId: session.userId,
    userName: session.userName,
    companyId: session.companyId,
    role: session.role,
    overrides: session.overrides,
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  }
}

/**
 * Same, but sends anonymous visitors to the login page — and, where the
 * company requires a second factor, sends members who have not enrolled to go
 * and do it (spec §14).
 *
 * ## Why the enforcement is here
 *
 * Every page and every server action already starts at this function. A policy
 * checked anywhere else is a policy with as many holes as there are routes
 * that forgot it, and the one that forgets is the one that matters.
 *
 * `allowUnenrolled` is for the two places that must stay reachable without a
 * second factor: the enrolment page itself, and signing out. Without those the
 * policy is not a requirement, it is a lockout.
 */
export async function requireActor(
  opts: { allowUnenrolled?: boolean } = {},
): Promise<ActorContext> {
  const actor = await currentActor()
  if (!actor) redirect('/login')

  if (!opts.allowUnenrolled) {
    const policy = await securityPolicy(actor.companyId)
    if (policy.requireMfa && !(await hasConfirmedMfa(actor.userId))) {
      redirect('/settings/security?enrol=required')
    }
  }

  return actor
}

/** The session record, for chrome that needs the company name. */
export async function currentSession() {
  const cookieStore = await cookies()
  return resolveSession(cookieStore.get(SESSION_COOKIE)?.value)
}
