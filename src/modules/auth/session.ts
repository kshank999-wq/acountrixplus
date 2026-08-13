import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq, and, gt } from 'drizzle-orm'
import { db } from '@/db'
import { sessions, memberships, users, companies, devices } from '@/db/schema'

export const SESSION_COOKIE = 'accountrix_session'
export const SESSION_TTL_DAYS = 30

/**
 * Session secret. A fixed development fallback keeps local setup friction-free,
 * but production must supply a real secret — a predictable signing key would
 * let anyone mint a session cookie.
 */
function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (secret) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production.')
  }
  return 'dev-only-insecure-session-secret'
}

/**
 * Signs a session id so a tampered or guessed cookie is rejected before it
 * ever reaches the database.
 */
export function signSessionId(sessionId: string): string {
  const signature = createHmac('sha256', sessionSecret()).update(sessionId).digest('base64url')
  return `${sessionId}.${signature}`
}

/** Returns the session id if the signature is valid, otherwise null. */
export function verifySessionCookie(cookieValue: string): string | null {
  const separator = cookieValue.lastIndexOf('.')
  if (separator <= 0) return null

  const sessionId = cookieValue.slice(0, separator)
  const provided = Buffer.from(cookieValue.slice(separator + 1))
  const expected = Buffer.from(
    createHmac('sha256', sessionSecret()).update(sessionId).digest('base64url'),
  )

  if (provided.length !== expected.length) return null
  return timingSafeEqual(provided, expected) ? sessionId : null
}

export async function createSession(
  userId: string,
  activeCompanyId: string | null,
  /**
   * The device this session belongs to (Phase 8).
   *
   * Optional, because a session without one still works — that is what every
   * session created before devices existed is. Sign-in supplies it so a lost
   * phone can be revoked on its own.
   */
  deviceId?: string | null,
) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)

  const [session] = await db
    .insert(sessions)
    .values({ userId, activeCompanyId, expiresAt, deviceId: deviceId ?? null })
    .returning()

  return { session, cookieValue: signSessionId(session.id) }
}

export async function destroySession(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

/**
 * Resolves a signed cookie into the acting user, their active company, and
 * their role there. Returns null for any failure — expired, revoked, tampered,
 * or a membership that has since been deactivated.
 */
export async function resolveSession(cookieValue: string | undefined) {
  if (!cookieValue) return null

  const sessionId = verifySessionCookie(cookieValue)
  if (!sessionId) return null

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      activeCompanyId: sessions.activeCompanyId,
      deviceId: sessions.deviceId,
      deviceRevokedAt: devices.revokedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    // Left, not inner: a session with no device is the normal case for a
    // browser signed in before Phase 8, and must keep resolving.
    .leftJoin(devices, eq(devices.id, sessions.deviceId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1)

  if (!row || !row.activeCompanyId) return null

  // Revocation takes effect on the next request, for the same reason the
  // membership below is re-checked every time: a lock that waits for a session
  // to expire is not a lock.
  if (row.deviceRevokedAt) return null

  // The membership is re-checked on every request: revoking access must take
  // effect immediately, not whenever the session happens to expire.
  const [membership] = await db
    .select({
      role: memberships.role,
      overrides: memberships.permissionOverrides,
      companyName: companies.name,
      companyIndustry: companies.industry,
    })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(
      and(
        eq(memberships.companyId, row.activeCompanyId),
        eq(memberships.userId, row.userId),
        eq(memberships.isActive, true),
      ),
    )
    .limit(1)

  if (!membership) return null

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    userName: row.userName,
    userEmail: row.userEmail,
    companyId: row.activeCompanyId,
    companyName: membership.companyName,
    companyIndustry: membership.companyIndustry,
    role: membership.role,
    overrides: membership.overrides,
    deviceId: row.deviceId,
  }
}

/** Cookie attributes. httpOnly + sameSite=lax; secure once behind TLS. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  }
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url')
}
