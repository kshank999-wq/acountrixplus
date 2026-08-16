import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
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
  const session = await currentSession()

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
      companyName={session?.companyName ?? 'Accountrix Plus'}
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
          isSelf: holder.userId === actor.userId,
        }))}
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
