import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { memberships } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import {
  PERMISSIONS,
  effectivePermissions,
  parseOverrides,
  type Permission,
  type PermissionOverrides,
  type Role,
} from '@/modules/permissions'
import { Refusal } from '@/modules/errors'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'

/**
 * Changing somebody's standing on a company (Phase 202, spec §14).
 *
 * ## The switch painted on
 *
 * Until this module, **`memberships` was insert-only**. A row was written by
 * `onboarding` or by accepting an invitation, and nothing anywhere updated
 * one — not the role, not the overrides, not `isActive`. The three
 * `delete(memberships)` statements in `practice/service.ts` are all keyed by
 * `practiceEngagementId`, so they remove only rows an engagement created.
 *
 * Three things were therefore true at once:
 *
 * | | |
 * | --- | --- |
 * | **no revocation** | `resolveSession` re-reads the membership on *every request* filtered by `isActive`, with a comment saying *"a lock that waits for a session to expire is not a lock"*. Nothing could set it false. §14 asks for revocation. |
 * | **no promotion** | `role` is read in eight places and chosen once, at invitation. A bookkeeper who becomes the accountant could not be made one, and the access board printed the role as plain text. |
 * | **no granular overrides** | `permissionOverrides`, ADR 0201's finding: parsed, *applied* by `effectivePermissions`, and writable by nothing. |
 *
 * And `'membership.update'` has been in `AuditAction` since Phase 3 with
 * nothing ever writing it — the same shape as `'organization.update'`, which
 * sat unwritten until Phase 78 built the service the vocabulary had
 * anticipated.
 *
 * ## Why one function rather than three
 *
 * Role, overrides and standing are one row and one decision. *"Make Sam the
 * accountant but take away period close"* is a single thing somebody means,
 * and splitting it into three calls would write three audit entries for it —
 * so the history would record a moment where Sam held `accounting:close`
 * because the role landed before the revoke did. One write, one
 * `membership.update`, before and after.
 *
 * ## The four refusals
 *
 * Each is a way to lock a company out of its own books or to widen access
 * invisibly, which is why they are refusals with sentences rather than
 * disabled buttons.
 *
 * 1. **Not your own membership.** An administrator who can edit their own row
 *    can revoke their own `company:manage` by typo and can grant themselves
 *    anything deliberately. One rule removes both, and the second person who
 *    holds `users:manage` is the way a company changes an administrator.
 * 2. **Somebody must keep `company:manage`.** Asserted over the *effective*
 *    permissions of every active membership after the change, so it catches a
 *    demotion, a revocation of access, and a `revoke` override in one
 *    predicate rather than three. Without it the last administrator can
 *    remove the only permission that could put it back.
 * 3. **A practice's membership is the engagement's.** The role a client
 *    granted a firm is *"a ceiling"*, in the access board's own words, and
 *    `endEngagement` deletes exactly the rows the engagement created. Editing
 *    one here would breach a ceiling the client agreed to and leave a row the
 *    engagement does not know it owns.
 * 4. **A permission may not be granted and revoked at once.**
 *    `effectivePermissions` resolves that silently — revocations are applied
 *    after grants, so revoke wins — but a stored override saying both is a
 *    statement nobody can read, and the next person to open it would be
 *    guessing which half was meant.
 *
 * Granting a permission the role does not include is **allowed**, and that is
 * the point rather than an oversight: `accounting:approve`'s own docstring
 * justifies its existence by *"a colleague granted `accounting:journal` as a
 * per-membership override"*. The control is on who may do it, not on what may
 * be granted.
 */

export type MembershipChange = {
  role?: Role
  /** Permissions added on top of the role. */
  grant?: Permission[]
  /** Permissions taken away from the role. Applied after grants. */
  revoke?: Permission[]
  /** False revokes access, with effect on the person's next request. */
  isActive?: boolean
}

/** One person's standing, for the access board. */
export type MembershipStanding = {
  userId: string
  role: Role
  overrides: PermissionOverrides | null
  isActive: boolean
  /** Non-null when the membership belongs to a practice engagement. */
  practiceEngagementId: string | null
}

function known(permission: string): permission is Permission {
  return (PERMISSIONS as readonly string[]).includes(permission)
}

/**
 * Overrides with one representation for "none".
 *
 * `{ grant: [], revoke: [] }` and `null` mean the same thing to
 * `effectivePermissions`, and storing both would make two rows that say the
 * same differ — so an override cleared back to nothing becomes null. Sorted
 * and deduplicated for the same reason: the audit trail compares these as
 * JSON, and a reordered list is not a change.
 */
function normalise(change: MembershipChange, before: PermissionOverrides | null): string | null {
  const grant = [...new Set(change.grant ?? before?.grant ?? [])].sort()
  const revoke = [...new Set(change.revoke ?? before?.revoke ?? [])].sort()

  if (grant.length === 0 && revoke.length === 0) return null
  return JSON.stringify({ grant, revoke })
}

/** Everybody with a membership on this company, active or not. */
export async function membershipStandings(ctx: ActorContext): Promise<MembershipStanding[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      overrides: memberships.permissionOverrides,
      isActive: memberships.isActive,
      practiceEngagementId: memberships.practiceEngagementId,
    })
    .from(memberships)
    .where(scoped(ctx, memberships))

  return rows.map((row) => ({
    userId: row.userId,
    role: row.role as Role,
    overrides: parseOverrides(row.overrides),
    isActive: row.isActive,
    practiceEngagementId: row.practiceEngagementId,
  }))
}

/**
 * Applies a change to one membership, or refuses with a reason.
 *
 * Gated on `users:manage` — the permission named for exactly this and, until
 * this phase, read only by `timebilling` deciding whether somebody may log
 * another person's hours. `inviteToCompany` and `withdrawInvitation` moved
 * onto it in the same phase, so *"who may change an individual's standing on
 * this company"* has one answer. `company:manage` keeps the company's own
 * arrangements, the engagement with a practice included: a contract with a
 * firm is a different question from a person's role, and the practice side
 * can end an engagement too.
 *
 * Only `owner` holds either today, so nothing any current role can do
 * changed. What changed is the seam: a company can now grant `users:manage`
 * alone and get an administrator who manages people without the Studio, the
 * module switches or the billing.
 */
export async function updateMembership(
  ctx: ActorContext,
  userId: string,
  change: MembershipChange,
) {
  requirePermission(ctx, 'users:manage')

  // 1. Not your own.
  if (userId === ctx.userId) {
    throw new Refusal(
      'You cannot change your own access. Somebody else who manages users has to do it — ' +
        'which is also what stops an administrator quietly granting themselves more.',
    )
  }

  for (const permission of [...(change.grant ?? []), ...(change.revoke ?? [])]) {
    if (!known(permission)) throw new Refusal(`There is no permission called "${permission}".`)
  }

  // 4. Not both at once.
  const both = (change.grant ?? []).filter((permission) =>
    (change.revoke ?? []).includes(permission),
  )
  if (both.length > 0) {
    throw new Refusal(
      `${both.join(', ')} cannot be both granted and revoked. A revocation would win, and an ` +
        'override that says both is not a statement anybody can read later.',
    )
  }

  const standings = await membershipStandings(ctx)
  const before = standings.find((standing) => standing.userId === userId)

  if (!before) throw new Refusal('That person does not have access to these books.')

  // 3. The engagement's, not ours.
  if (before.practiceEngagementId) {
    throw new Refusal(
      'That access came from a practice engagement. The role on the engagement is a ceiling the ' +
        'company agreed to, so change it there or end the engagement — editing the membership ' +
        'would leave a row the engagement does not know it owns.',
    )
  }

  const overrides = normalise(change, before.overrides)
  const after: MembershipStanding = {
    ...before,
    role: change.role ?? before.role,
    overrides: parseOverrides(overrides),
    isActive: change.isActive ?? before.isActive,
  }

  // 2. Somebody has to keep the keys.
  if (administratorsAfter(standings, after).length === 0) {
    throw new Refusal(
      'Somebody has to be able to manage this company. That change would leave nobody with ' +
        'company:manage, and the permission that could put it back is the one it removes.',
    )
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(memberships)
      .set({
        role: after.role,
        permissionOverrides: overrides,
        isActive: after.isActive,
      })
      .where(scoped(ctx, memberships, eq(memberships.userId, userId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'membership.update',
        entityType: 'membership',
        entityId: row.id,
        before: {
          role: before.role,
          grant: before.overrides?.grant ?? [],
          revoke: before.overrides?.revoke ?? [],
          isActive: before.isActive,
        },
        after: {
          role: after.role,
          grant: after.overrides?.grant ?? [],
          revoke: after.overrides?.revoke ?? [],
          isActive: after.isActive,
        },
      },
      tx,
    )

    return row
  })
}

/**
 * Who would still be able to administer the company after a change.
 *
 * Exported because it is the refusal worth testing directly: it is a property
 * of a *set* of memberships rather than of the one being edited, and the three
 * ways to break it — demote the last administrator, revoke their access,
 * revoke the permission itself — all come through here rather than through
 * three separate guards that could drift apart.
 */
export function administratorsAfter(
  standings: MembershipStanding[],
  changed: MembershipStanding,
): MembershipStanding[] {
  return standings
    .map((standing) => (standing.userId === changed.userId ? changed : standing))
    .filter(
      (standing) =>
        standing.isActive &&
        effectivePermissions(standing.role, standing.overrides).has('company:manage'),
    )
}
