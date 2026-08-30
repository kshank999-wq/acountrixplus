import { headers } from 'next/headers'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listIntakeKeys, recentSubmissions } from '@/modules/crm/intake'
import { CRM_NAV } from '../nav'
import { IntakeKeys } from './intake-keys'

export const dynamic = 'force-dynamic'

export default async function IntakePage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'crm:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Lead intake</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the CRM.
        </p>
      </main>
    )
  }

  const [keys, submissions] = await Promise.all([
    listIntakeKeys(actor),
    recentSubmissions(actor, 30),
  ])

  // Build the widget snippet against whatever host this is actually served on.
  const headerStore = await headers()
  const host = headerStore.get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') ? 'http' : 'https'
  const baseUrl = `${protocol}://${host}`

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="crm"
    >
      <SubNav items={CRM_NAV} active="/crm/intake" />

      <IntakeKeys
        baseUrl={baseUrl}
        keys={keys.map((key) => ({
          id: key.id,
          name: key.name,
          publicKey: key.publicKey,
          allowedOrigins: key.allowedOrigins,
          hourlyLimit: key.hourlyLimit,
          isActive: key.isActive,
          submissionCount: key.submissionCount,
          lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString().slice(0, 10) : null,
        }))}
        submissions={submissions.map((s) => ({
          id: s.id,
          accepted: s.accepted,
          rejectionReason: s.rejectionReason,
          ipPrefix: s.ipPrefix,
          origin: s.origin,
          receivedAt: s.receivedAt.toISOString().slice(0, 16).replace('T', ' '),
        }))}
        canManage={can(actor, 'crm:manage')}
      />
    </AppShell>
  )
}
