import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from '@/db'
import { actionTokens, users } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import {
  claimCheck,
  lettersFor,
  normaliseLogin,
  redemptionCheck,
} from '@/modules/auth/address-change'
import { issueToken, lookupToken, redeemToken, TOKEN_TTL_MINUTES } from './tokens'
import { addressChangeUrl, sendTransactional } from './service'
import type { ActorContext } from '@/modules/tenancy/context'

/**
 * Claiming a new sign-in address, and finishing the claim (Phase 98).
 *
 * The decisions are in `@/modules/auth/address-change`; this is the part that
 * touches the database and the post. It sits beside `password-reset.ts` for the
 * same reason that file exists: a letter with a token in it is a thing worth
 * keeping in one place, where the order of operations can be read.
 */

export type ClaimResult = { accepted: true } | { accepted: false; error: string }

/**
 * Starts a claim on a new sign-in address.
 *
 * Returns `accepted` for anything that is not wrong with the *request*, which
 * includes an address that already belongs to somebody. `requestPasswordReset`
 * settled that stance — *"says exactly the same thing either way"* — and a
 * screen that answered differently would be the one place in the application
 * that confirms whether an account exists.
 */
export async function requestAddressChange(
  ctx: ActorContext,
  input: { requested: string; companyName: string },
): Promise<ClaimResult> {
  const [me] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))

  if (!me) return { accepted: false, error: 'That account no longer exists.' }

  const verdict = claimCheck({ current: me.email, requested: input.requested })
  if (!verdict.ok) return { accepted: false, error: verdict.why }

  /**
   * One live claim per person.
   *
   * `issueToken` supersedes by purpose **and address**, which is the right rule
   * for an invitation — two invitations to two addresses are two real
   * invitations. Here they are one person changing their mind, and leaving a
   * live claim on an address they abandoned means a link they never used can
   * still move their account a month later.
   */
  await db
    .update(actionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(actionTokens.purpose, 'email_change'),
        eq(actionTokens.userId, ctx.userId),
        isNull(actionTokens.redeemedAt),
        isNull(actionTokens.revokedAt),
      ),
    )

  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, verdict.address), ne(users.id, ctx.userId)))

  // Accepted, and quietly does nothing. See above.
  if (taken) return { accepted: true }

  const issued = await issueToken({
    purpose: 'email_change',
    email: verdict.address,
    userId: ctx.userId,
    requestedIp: ctx.ipAddress ?? null,
  })

  const letters = lettersFor({
    current: me.email,
    requested: verdict.address,
    companyName: input.companyName,
    url: addressChangeUrl(issued.token),
    ttlMinutes: TOKEN_TTL_MINUTES.email_change,
  })

  /**
   * Both letters, and the link only on the one the core put it on.
   *
   * `action` is built from `letter.url`, which the core types as nullable and
   * sets to null on the notice. So the rule that the address being *left* never
   * receives a way to complete the change is enforced by the shape of the data
   * rather than by this function remembering it.
   */
  for (const [kind, letter] of [
    ['email_change', letters.confirm],
    ['security_alert', letters.notice],
  ] as const) {
    await sendTransactional({
      to: letter.to,
      toName: me.name,
      companyId: ctx.companyId,
      kind,
      subject: letter.subject,
      body: letter.body,
      action: letter.url ? { label: 'Confirm this address', url: letter.url } : undefined,
      reference: issued.id,
    }).catch(() => undefined)
  }

  await recordAudit(ctx, {
    action: 'user.address_claim',
    entityType: 'user',
    entityId: ctx.userId,
    after: {
      // The address being claimed, not yet anybody's.
      requested: verdict.address,
      summary: `Asked to move sign-in from ${normaliseLogin(me.email)} to ${verdict.address}.`,
    },
  })

  return { accepted: true }
}

export type CompleteResult =
  | { ok: true; email: string; previous: string }
  | { ok: false; error: string }

/**
 * Finishes a claim, and writes `users.email` — the first code in this
 * application ever to do so.
 *
 * Other sessions are deliberately **not** ended, which is the opposite of what
 * `completePasswordReset` does, and the difference is worth stating. A reset
 * ends them because the reason somebody resets is often that another person
 * knows the password. Nothing here suggests the password is known: what
 * changed is where recovery goes. Ending sessions would sign out the real owner
 * — who, if this claim was somebody else's work, no longer has the address the
 * new links go to and would be locked out by the very act meant to protect
 * them.
 */
export async function completeAddressChange(input: {
  token: string
  companyName: string
  ipAddress?: string | null
  userAgent?: string | null
}): Promise<CompleteResult> {
  const lookup = await lookupToken('email_change', input.token)

  if (!lookup.ok) {
    return {
      ok: false,
      error:
        lookup.reason === 'expired'
          ? 'That link has expired. Ask for the change again from your security settings.'
          : lookup.reason === 'used'
            ? 'That link has already been used.'
            : 'That link is no longer valid. Ask for the change again from your security settings.',
    }
  }

  const claimed = normaliseLogin(lookup.token.email)
  const userId = lookup.token.userId

  if (!userId) return { ok: false, error: 'That link is no longer valid.' }

  const [me] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))

  if (!me) return { ok: false, error: 'That account no longer exists.' }

  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, claimed), ne(users.id, userId)))

  const verdict = redemptionCheck({
    claimed,
    current: me.email,
    takenByAnother: Boolean(taken),
  })

  if (!verdict.ok) return { ok: false, error: verdict.why }

  const previous = normaliseLogin(me.email)

  await db.transaction(async (tx) => {
    await tx.update(users).set({ email: claimed }).where(eq(users.id, userId))
    await redeemToken(lookup.token.id, tx)
  })

  /**
   * The address that lost the account is told twice: once when the change was
   * asked for, and again now that it has happened.
   *
   * The second letter is the one that matters to somebody who was not watching
   * their inbox an hour ago. It carries no link for the same reason the first
   * notice did not.
   */
  await sendTransactional({
    to: previous,
    toName: me.name,
    companyId: null,
    kind: 'security_alert',
    subject: `Your sign-in address for ${input.companyName} has changed`,
    body: [
      `Sign-in for ${input.companyName} has moved from ${previous} to ${claimed}.`,
      'This address can no longer be used to sign in or to reset the password.',
      'If you did not do this, contact whoever administers your books now — this message carries no link because it cannot be undone from an email.',
    ],
    reference: lookup.token.id,
  }).catch(() => undefined)

  return { ok: true, email: claimed, previous }
}
