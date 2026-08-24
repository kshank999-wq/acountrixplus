import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies, memberships, practiceMembers, practices, users } from '@/db/schema'
import { hashPassword } from '@/modules/auth/password'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { Role } from '@/modules/permissions'
import {
  issueToken,
  lookupToken,
  pendingInvitations,
  redeemToken,
  revokeInvitation,
} from './tokens'
import { grantAtLiveEngagements } from '@/modules/practice/service'
import { sendCompanyInvitation, sendPracticeInvitation } from './service'
import { DomainError } from '@/modules/errors'

/**
 * Invitations (spec §14: "invite each professional using an individual account;
 * never share owner credentials").
 *
 * ## An invitation proves an address; it never carries a password
 *
 * Until this phase, adding a colleague meant typing a password *for* them and
 * telling them what it was. That is spec §14's own warning in a subtler form:
 * the credential existed before its owner did, at least two people knew it, and
 * whichever of them changed it later, the audit log could not say which of them
 * had done anything in between.
 *
 * So an invitation carries a link and no secret. The invitee chooses a password
 * nobody else has ever known, and the membership is created at the moment they
 * do — not before, which means a mistyped address grants nothing rather than
 * granting access to a stranger who has been handed a working password.
 */

export class InvitationError extends DomainError {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'InvitationError'
  }
}

/** Invites somebody to a company. Creates no user and grants nothing. */
export async function inviteToCompany(
  ctx: ActorContext,
  input: { email: string; name?: string; role: Role },
): Promise<{ tokenId: string; alreadyMember: boolean }> {
  requirePermission(ctx, 'company:manage')

  const email = input.email.trim().toLowerCase()
  if (!email.includes('@')) throw new InvitationError('That is not an email address.')

  const [company] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1)

  if (!company) throw new InvitationError('That company does not exist.')

  // Somebody already inside is not invited again — but the caller is told,
  // rather than being left to wonder why no email arrived.
  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, ctx.companyId), eq(users.email, email)))
    .limit(1)

  if (existing) {
    return { tokenId: '', alreadyMember: true }
  }

  return db.transaction(async (tx) => {
    const issued = await issueToken(
      {
        purpose: 'company_invitation',
        email,
        companyId: ctx.companyId,
        role: input.role,
        invitedName: input.name?.trim() || null,
        invitedBy: ctx.userId,
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'invitation.send',
        entityType: 'action_token',
        entityId: issued.id,
        after: { email, role: input.role },
      },
      tx,
    )

    await sendCompanyInvitation({
      to: email,
      toName: input.name?.trim() || null,
      companyName: company.name,
      inviterName: ctx.userName,
      role: input.role,
      token: issued.token,
      companyId: ctx.companyId,
      reference: issued.id,
    })

    return { tokenId: issued.id, alreadyMember: false }
  })
}

/** Invites somebody to a practice. Same shape, same guarantee. */
export async function inviteToPractice(
  actor: { userId: string; userName: string },
  input: { practiceId: string; email: string; name?: string },
): Promise<{ tokenId: string; alreadyMember: boolean }> {
  const email = input.email.trim().toLowerCase()
  if (!email.includes('@')) throw new InvitationError('That is not an email address.')

  const [owner] = await db
    .select({ practiceRole: practiceMembers.practiceRole, practiceName: practices.name })
    .from(practiceMembers)
    .innerJoin(practices, eq(practices.id, practiceMembers.practiceId))
    .where(
      and(
        eq(practiceMembers.practiceId, input.practiceId),
        eq(practiceMembers.userId, actor.userId),
        eq(practiceMembers.isActive, true),
      ),
    )
    .limit(1)

  if (!owner) throw new InvitationError('You do not work at that practice.')
  if (owner.practiceRole !== 'owner') {
    throw new InvitationError('Only a practice owner can invite somebody.')
  }

  const [existing] = await db
    .select({ id: practiceMembers.id })
    .from(practiceMembers)
    .innerJoin(users, eq(users.id, practiceMembers.userId))
    .where(and(eq(practiceMembers.practiceId, input.practiceId), eq(users.email, email)))
    .limit(1)

  if (existing) return { tokenId: '', alreadyMember: true }

  const issued = await issueToken({
    purpose: 'practice_invitation',
    email,
    practiceId: input.practiceId,
    invitedName: input.name?.trim() || null,
    invitedBy: actor.userId,
  })

  await sendPracticeInvitation({
    to: email,
    toName: input.name?.trim() || null,
    practiceName: owner.practiceName,
    inviterName: actor.userName,
    token: issued.token,
    reference: issued.id,
  })

  return { tokenId: issued.id, alreadyMember: false }
}

export type InvitationPreview = {
  email: string
  invitedName: string | null
  /** What they are being invited to. */
  destination: string
  kind: 'company' | 'practice'
  role: Role | null
  /** True when this address already has an account and only needs to accept. */
  hasAccount: boolean
}

/** What an invitation link is offering, for the page before anybody types. */
export async function previewInvitation(
  token: string,
): Promise<{ ok: true; preview: InvitationPreview } | { ok: false; reason: string }> {
  for (const purpose of ['company_invitation', 'practice_invitation'] as const) {
    const lookup = await lookupToken(purpose, token)
    if (!lookup.ok) {
      // Keep looking: a token is one purpose or the other, and `not_found`
      // here only means "not this one".
      if (lookup.reason !== 'not_found') return { ok: false, reason: message(lookup.reason) }
      continue
    }

    const record = lookup.token
    const [account] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, record.email))
      .limit(1)

    const destination = record.companyId
      ? ((
          await db
            .select({ name: companies.name })
            .from(companies)
            .where(eq(companies.id, record.companyId))
            .limit(1)
        )[0]?.name ?? 'a company')
      : ((
          await db
            .select({ name: practices.name })
            .from(practices)
            .where(eq(practices.id, record.practiceId as string))
            .limit(1)
        )[0]?.name ?? 'a practice')

    return {
      ok: true,
      preview: {
        email: record.email,
        invitedName: record.invitedName,
        destination,
        kind: record.companyId ? 'company' : 'practice',
        role: record.role,
        hasAccount: Boolean(account),
      },
    }
  }

  return { ok: false, reason: 'That invitation link is not valid. Ask for a new one.' }
}

function message(reason: string): string {
  if (reason === 'expired') return 'That invitation has expired. Ask for a new one.'
  if (reason === 'used') return 'That invitation has already been accepted.'
  if (reason === 'revoked') return 'That invitation was withdrawn.'
  return 'That invitation link is not valid.'
}

export type AcceptResult =
  | { ok: true; userId: string; companyId: string | null; practiceId: string | null }
  | { ok: false; error: string }

/**
 * Accepts an invitation, creating the account if there is not one.
 *
 * `password` is required only for somebody new. An existing user accepting a
 * second invitation is already themselves and does not need to prove it again —
 * and asking them for a password here would be asking for their password on a
 * page they reached from an email, which is the exact shape of the thing people
 * are told never to do.
 */
export async function acceptInvitation(input: {
  token: string
  password?: string
  name?: string
}): Promise<AcceptResult> {
  for (const purpose of ['company_invitation', 'practice_invitation'] as const) {
    const lookup = await lookupToken(purpose, input.token)
    if (!lookup.ok) {
      if (lookup.reason !== 'not_found') return { ok: false, error: message(lookup.reason) }
      continue
    }

    const record = lookup.token

    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, record.email))
      .limit(1)

    if (!existingUser) {
      if (!input.password || input.password.length < 8) {
        return { ok: false, error: 'Choose a password of at least 8 characters.' }
      }
    }

    const passwordHash = existingUser ? null : await hashPassword(input.password as string)

    return db.transaction(async (tx) => {
      await redeemToken(record.id, tx)

      const user =
        existingUser ??
        (
          await tx
            .insert(users)
            .values({
              email: record.email,
              name: (input.name?.trim() || record.invitedName || record.email.split('@')[0]).slice(0, 120),
              passwordHash: passwordHash as string,
            })
            .returning()
        )[0]

      if (record.companyId) {
        await tx
          .insert(memberships)
          .values({
            companyId: record.companyId,
            userId: user.id,
            role: (record.role ?? 'readonly') as never,
          })
          // Somebody who joined by another route between the invitation and the
          // click keeps whatever they already have rather than being demoted to
          // what the invitation offered.
          .onConflictDoNothing({ target: [memberships.companyId, memberships.userId] })

        await recordAudit(
          {
            userId: user.id,
            userName: user.name,
            companyId: record.companyId,
            role: (record.role ?? 'readonly') as Role,
          },
          {
            action: 'invitation.accept',
            entityType: 'membership',
            entityId: user.id,
            after: { email: record.email, role: record.role },
          },
          tx,
        )
      }

      if (record.practiceId) {
        await tx
          .insert(practiceMembers)
          .values({
            practiceId: record.practiceId,
            userId: user.id,
            practiceRole: 'staff',
            defaultRole: 'accountant',
          })
          .onConflictDoUpdate({
            target: [practiceMembers.practiceId, practiceMembers.userId],
            set: { isActive: true },
          })

        // Every client the firm already serves, at once — through the same
        // helper `addPracticeMember` uses, because two implementations of
        // "which clients does a new colleague reach" is how the invited route
        // and the added-by-hand route come to differ.
        await grantAtLiveEngagements(tx, record.practiceId, user.id, 'accountant')
      }

      return {
        ok: true as const,
        userId: user.id,
        companyId: record.companyId,
        practiceId: record.practiceId,
      }
    })
  }

  return { ok: false, error: 'That invitation link is not valid. Ask for a new one.' }
}

/** Invitations still waiting, for the settings screen. */
export async function companyInvitations(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')
  return pendingInvitations({ companyId: ctx.companyId })
}

/** Withdraws one. Scoped, so one company cannot cancel another's. */
export async function withdrawCompanyInvitation(
  ctx: ActorContext,
  tokenId: string,
): Promise<boolean> {
  requirePermission(ctx, 'company:manage')
  return revokeInvitation(tokenId, { companyId: ctx.companyId })
}
