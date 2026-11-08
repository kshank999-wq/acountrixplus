import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { PERMISSIONS, ROLE_NAMES, ROLE_PERMISSIONS } from '@/modules/permissions'
import { AppShell, SubNav } from '@/components/app-shell'
import { engagementsForCompany, whoHasAccess } from '@/modules/practice/service'
import { companyInvitations } from '@/modules/notify/invitations'
import { SETTINGS_NAV } from '../nav'
import { AccessBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Who can open these books (spec §14).
 *
 * The page a company should be able to reach in one click and read in ten
 * seconds. An access list that does not distinguish "our bookkeeper" from
 * "somebody at the firm we used two years ago" is a list nobody audits.
 */
export default async function AccessPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Who has access</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const [holders, engagements, invitations] = await Promise.all([
    whoHasAccess(actor),
    engagementsForCompany(actor),
    companyInvitations(actor),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="bookkeeping"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/access" />
      <AccessBoard
        holders={holders.map((holder) => ({
          userId: holder.userId,
          name: holder.name,
          email: holder.email,
          role: holder.role,
          viaPracticeName: holder.viaPracticeName,
          viaStaffing: holder.viaStaffing,
          isSelf: holder.userId === actor.userId,
          /*
            Phase 202. `whoHasAccess` has selected and returned `isActive`
            since Phase 25 and this map dropped it, so the board could not show
            whether somebody's access had been revoked — which was moot while
            nothing could revoke it, and is the second link in the chain the
            column scan found. The overrides arrive with it.
          */
          isActive: holder.isActive,
          grant: holder.overrides?.grant ?? [],
          revoke: holder.overrides?.revoke ?? [],
        }))}
        /*
          The permission vocabulary as data rather than imported into the
          client. `permissions/index.ts` is pure, but shipping it would put the
          whole roster and every role's defaults in the bundle to render a
          handful of checkboxes — and the client-bundle scan exists because
          that question is worth asking each time rather than assuming.
        */
        permissions={[...PERMISSIONS]}
        roleDefaults={Object.fromEntries(
          ROLE_NAMES.map((role) => [role, [...ROLE_PERMISSIONS[role]]]),
        )}
        canManageUsers={can(actor, 'users:manage')}
        engagements={engagements.map((engagement) => ({
          id: engagement.id,
          practiceId: engagement.practiceId,
          practiceName: engagement.practiceName,
          status: engagement.status,
          initiatedBy: engagement.initiatedBy,
          grantedRole: engagement.grantedRole,
          note: engagement.note,
          requestedAt: engagement.requestedAt.toISOString().slice(0, 10),
          endedAt: engagement.endedAt ? engagement.endedAt.toISOString().slice(0, 10) : null,
        }))}
        invitations={invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          invitedName: invitation.invitedName,
          role: invitation.role ?? 'readonly',
          expiresAt: invitation.expiresAt.toISOString().slice(0, 10),
        }))}
        canManage={can(actor, 'company:manage')}
      />
    </AppShell>
  )
}
