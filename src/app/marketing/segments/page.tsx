import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listSegments } from '@/modules/marketing/audience'
import { describeDefinition, parseDefinition } from '@/modules/marketing/segments'
import { MARKETING_NAV } from '../nav'
import { NoAccess } from '../ui'
import { SegmentWorkspace } from './segment-workspace'

export const dynamic = 'force-dynamic'

/** Audience segments (spec §10). */
export default async function SegmentsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'marketing:view')) {
    return <NoAccess role={actor.role} what="Segments" />
  }

  const segments = await listSegments(actor)

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="marketing"
    >
      <SubNav items={MARKETING_NAV} active="/marketing/segments" />

      <SegmentWorkspace
        canManage={can(actor, 'marketing:manage')}
        segments={segments.map((segment) => {
          const definition = parseDefinition(segment.definition)
          return {
            id: segment.id,
            name: segment.name,
            description: segment.description,
            summary: describeDefinition(definition),
            definition,
          }
        })}
      />
    </AppShell>
  )
}
