import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listSuppressions } from '@/modules/marketing/audience'
import { MARKETING_NAV } from '../nav'
import { Card, Empty, NoAccess } from '../ui'
import { SuppressionRow } from './suppression-row'

export const dynamic = 'force-dynamic'

const REASON_LABELS: Record<string, string> = {
  unsubscribe: 'Unsubscribed',
  bounce: 'Bounced',
  complaint: 'Marked as spam',
  manual: 'Added by hand',
}

/**
 * The suppression list (spec §10, §19).
 *
 * Company-wide and keyed by address rather than by contact, so it survives a
 * contact being deleted and recreated by a later lead-intake submission —
 * someone who unsubscribed stays unsubscribed.
 */
export default async function SuppressionsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'marketing:view')) {
    return <NoAccess role={actor.role} what="Suppressions" />
  }

  const suppressions = await listSuppressions(actor, 200)
  const canManage = can(actor, 'marketing:manage')

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="marketing"
    >
      <SubNav items={MARKETING_NAV} active="/marketing/suppressions" />

      <Card
        title="Do not email"
        subtitle="Checked again at send time, whatever a segment says."
      >
        {suppressions.length === 0 ? (
          <Empty>Nobody has unsubscribed or bounced.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {suppressions.map((row) => (
              <SuppressionRow
                key={row.id}
                email={row.email}
                reason={REASON_LABELS[row.reason] ?? row.reason}
                notes={row.notes}
                createdAt={row.createdAt?.toISOString().slice(0, 10) ?? null}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-3 text-xs text-muted">
        Removing someone from this list lifts the hard block only. Their consent stays
        withdrawn until they opt in again — it is theirs to give, not ours to restore.
      </p>
    </AppShell>
  )
}
