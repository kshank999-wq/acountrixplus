import { randomBytes } from 'node:crypto'
import { and, eq, isNull, gt, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { actionTokens } from '@/db/schema'
import { hashPassword, verifyPassword } from '@/modules/auth/password'
import type { Role } from '@/modules/permissions'
import { DomainError } from '@/modules/errors'

/**
 * Single-use links (spec §19).
 *
 * One mechanism serves password reset, company invitations and practice
 * invitations, because all three are the same sentence: *whoever can read this
 * address may do this one thing, once, soon.*
 *
 * Three properties, and each closes a specific failure:
 *
 *  - **Hashed at rest.** A reset token is a password for the hour it lives. A
 *    database backup or a leaked query log gets hashes.
 *  - **Single use.** `redeemedAt` is stamped inside the same transaction that
 *    does the work, so a link forwarded to a colleague, replayed from a browser
 *    history, or clicked twice by a mail scanner cannot be spent twice.
 *  - **Short-lived**, and shorter for a reset than an invitation. A reset is
 *    answering a request somebody made a minute ago; an invitation might sit in
 *    an inbox over a weekend.
 */

export type TokenPurpose =
  | 'password_reset'
  | 'company_invitation'
  | 'practice_invitation'
  | 'email_change'

export const TOKEN_TTL_MINUTES: Record<TokenPurpose, number> = {
  // Long enough to walk to another device and find the email; short enough
  // that a token in a shared inbox stops mattering by lunchtime.
  password_reset: 60,
  company_invitation: 7 * 24 * 60,
  practice_invitation: 7 * 24 * 60,
  /**
   * The same hour a reset gets, for the same reason (Phase 98).
   *
   * Long enough to walk to another device and find the letter; short enough
   * that a claim left in a shared inbox stops mattering by lunchtime. This is
   * the only place the number lives — `lettersFor` is handed it rather than
   * declaring a second one that would have to agree.
   */
  email_change: 60,
}

/**
 * How much of the plaintext is stored in the clear so the row can be found.
 *
 * Eight characters of base64url is 48 bits, which narrows a lookup to one row
 * in practice and leaves the other ~200 bits of a 32-byte token doing the
 * actual work. Phase 13's "check every candidate" approach is right for ten
 * recovery codes belonging to one user and hopeless for every live token in
 * the system.
 */
const PREFIX_LENGTH = 8

export type IssuedToken = {
  id: string
  /** The whole thing, to put in a link. Never stored, never logged. */
  token: string
  expiresAt: Date
}

export type IssueInput = {
  purpose: TokenPurpose
  email: string
  userId?: string | null
  companyId?: string | null
  practiceId?: string | null
  role?: Role | null
  invitedName?: string | null
  invitedBy?: string | null
  requestedIp?: string | null
}

/**
 * Mints a token and supersedes any earlier live one for the same thing.
 *
 * Superseding matters: without it, asking for a reset three times leaves three
 * working links, and the two the person did not use are two extra chances for
 * whoever else can read that mailbox.
 */
export async function issueToken(
  input: IssueInput,
  exec: Executor = db,
): Promise<IssuedToken> {
  const email = input.email.trim().toLowerCase()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES[input.purpose] * 60_000)

  await exec
    .update(actionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(actionTokens.purpose, input.purpose),
        eq(actionTokens.email, email),
        isNull(actionTokens.redeemedAt),
        isNull(actionTokens.revokedAt),
        // Scoped to the same destination, so an invitation to one company does
        // not kill a live invitation to another.
        input.companyId ? eq(actionTokens.companyId, input.companyId) : sql`true`,
        input.practiceId ? eq(actionTokens.practiceId, input.practiceId) : sql`true`,
      ),
    )

  const [row] = await exec
    .insert(actionTokens)
    .values({
      purpose: input.purpose,
      lookupPrefix: token.slice(0, PREFIX_LENGTH),
      tokenHash: await hashPassword(token),
      email,
      userId: input.userId ?? null,
      companyId: input.companyId ?? null,
      practiceId: input.practiceId ?? null,
      role: (input.role ?? null) as never,
      invitedName: input.invitedName ?? null,
      invitedBy: input.invitedBy ?? null,
      requestedIp: input.requestedIp ?? null,
      expiresAt,
    })
    .returning({ id: actionTokens.id })

  return { id: row.id, token, expiresAt }
}

export type TokenRecord = {
  id: string
  purpose: TokenPurpose
  email: string
  userId: string | null
  companyId: string | null
  practiceId: string | null
  role: Role | null
  invitedName: string | null
  expiresAt: Date
}

/** Why a token did not work. Never shown in full to an anonymous caller. */
export type TokenFailure = 'not_found' | 'expired' | 'used' | 'revoked'

export type TokenLookup =
  | { ok: true; token: TokenRecord }
  | { ok: false; reason: TokenFailure }

/**
 * Finds and verifies a token without spending it.
 *
 * Used to render the page before the person has typed anything — a reset form
 * that only tells you the link is dead *after* you have chosen a password is a
 * form that wastes the one minute somebody had.
 */
export async function lookupToken(
  purpose: TokenPurpose,
  token: string,
  exec: Executor = db,
): Promise<TokenLookup> {
  const trimmed = token.trim()
  if (trimmed.length < PREFIX_LENGTH) return { ok: false, reason: 'not_found' }

  const candidates = await exec
    .select()
    .from(actionTokens)
    .where(
      and(
        eq(actionTokens.purpose, purpose),
        eq(actionTokens.lookupPrefix, trimmed.slice(0, PREFIX_LENGTH)),
      ),
    )
    .limit(10)

  for (const candidate of candidates) {
    if (!(await verifyPassword(trimmed, candidate.tokenHash))) continue

    // Order matters for the message a person reads: "already used" is more
    // useful than "expired" for a link that was both.
    if (candidate.revokedAt) return { ok: false, reason: 'revoked' }
    if (candidate.redeemedAt) return { ok: false, reason: 'used' }
    if (candidate.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' }

    return {
      ok: true,
      token: {
        id: candidate.id,
        purpose: candidate.purpose,
        email: candidate.email,
        userId: candidate.userId,
        companyId: candidate.companyId,
        practiceId: candidate.practiceId,
        role: candidate.role as Role | null,
        invitedName: candidate.invitedName,
        expiresAt: candidate.expiresAt,
      },
    }
  }

  return { ok: false, reason: 'not_found' }
}

export class TokenSpentError extends DomainError {
  readonly status = 409
  constructor() {
    super('That link has already been used.')
    this.name = 'TokenSpentError'
  }
}

/**
 * Spends a token, inside the caller's transaction.
 *
 * The `WHERE redeemed_at IS NULL` is the whole guarantee, and it is the same
 * shape as Phase 15's billed-once clause and Phase 16's depreciation index:
 * the precondition lives in the write, so two simultaneous clicks produce one
 * effect. A read-then-write here would let a forwarded invitation create two
 * accounts, or a double-submitted reset run twice.
 *
 * Called *inside* the transaction that does the work, so if that work fails the
 * token is not spent — somebody whose password change hit a constraint should
 * not also lose their only link.
 */
export async function redeemToken(tokenId: string, exec: Executor): Promise<void> {
  const claimed = await exec
    .update(actionTokens)
    .set({ redeemedAt: new Date() })
    .where(and(eq(actionTokens.id, tokenId), isNull(actionTokens.redeemedAt)))
    .returning({ id: actionTokens.id })

  if (claimed.length === 0) throw new TokenSpentError()
}

/** Kills every live token of a purpose for an address. */
export async function revokeTokensFor(
  purpose: TokenPurpose,
  email: string,
  exec: Executor = db,
): Promise<number> {
  const revoked = await exec
    .update(actionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(actionTokens.purpose, purpose),
        eq(actionTokens.email, email.trim().toLowerCase()),
        isNull(actionTokens.redeemedAt),
        isNull(actionTokens.revokedAt),
      ),
    )
    .returning({ id: actionTokens.id })

  return revoked.length
}

/**
 * Expired tokens are swept by the `action_tokens` retention policy, not here.
 *
 * This module used to carry its own `pruneExpiredTokens(olderThanDays = 30)`.
 * It had no production caller and was kept looking alive by one test that
 * called it directly, while the sweep `sweepAll` actually runs lived in
 * `modules/retention`. Two answers to "how long is an expired token kept", and
 * the reachable one was the one a reader would not find: changing the number
 * here would have done nothing at all (Phase 101).
 */

/** Live invitations to a company, for the settings screen. */
export async function pendingInvitations(
  where: { companyId?: string; practiceId?: string },
  exec: Executor = db,
) {
  const purpose: TokenPurpose = where.companyId ? 'company_invitation' : 'practice_invitation'

  return exec
    .select({
      id: actionTokens.id,
      email: actionTokens.email,
      invitedName: actionTokens.invitedName,
      role: actionTokens.role,
      expiresAt: actionTokens.expiresAt,
      createdAt: actionTokens.createdAt,
    })
    .from(actionTokens)
    .where(
      and(
        eq(actionTokens.purpose, purpose),
        where.companyId
          ? eq(actionTokens.companyId, where.companyId)
          : eq(actionTokens.practiceId, where.practiceId as string),
        isNull(actionTokens.redeemedAt),
        isNull(actionTokens.revokedAt),
        gt(actionTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(actionTokens.createdAt)
}

/** Withdraws one invitation by id. */
export async function revokeInvitation(
  tokenId: string,
  where: { companyId?: string; practiceId?: string },
  exec: Executor = db,
): Promise<boolean> {
  const revoked = await exec
    .update(actionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(actionTokens.id, tokenId),
        // Scoped, so one company cannot withdraw another's invitation by id.
        where.companyId
          ? eq(actionTokens.companyId, where.companyId)
          : eq(actionTokens.practiceId, where.practiceId as string),
        isNull(actionTokens.redeemedAt),
      ),
    )
    .returning({ id: actionTokens.id })

  return revoked.length > 0
}
