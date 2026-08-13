import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listDocuments, listTemplates } from '@/modules/design/documents'
import { parseBlocks } from '@/modules/design/blocks'
import { MARKETING_NAV } from '../nav'
import { NoAccess } from '../ui'
import { CreativeLibrary } from './creative-library'

export const dynamic = 'force-dynamic'

/**
 * The shared creative studio (spec §8).
 *
 * These are the same design documents proposals use — same table, same
 * templates, same brand kit. Reuse is the point: a section written for a
 * proposal can be copied into a newsletter without being retyped.
 */
export default async function CreativePage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'marketing:view')) {
    return <NoAccess role={actor.role} what="Creative" />
  }

  const [documents, templates] = await Promise.all([
    listDocuments(actor, 'marketing'),
    listTemplates(actor),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="marketing"
    >
      <SubNav items={MARKETING_NAV} active="/marketing/creative" />

      <CreativeLibrary
        canManage={can(actor, 'marketing:manage')}
        documents={documents.map((document) => ({
          id: document.id,
          name: document.name,
          blockCount: parseBlocks(document.blocks).length,
          updatedAt: document.updatedAt?.toISOString() ?? null,
        }))}
        templates={templates.map((template) => ({
          key: template.key,
          name: template.name,
          description: template.description,
          source: template.source,
        }))}
      />
    </AppShell>
  )
}
