import { cookies } from 'next/headers'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { mfaStatus } from '@/modules/auth/mfa'
import {
  loginHistoryForUser,
  recentFailuresForCompany,
  securityPolicy,
} from '@/modules/auth/login-history'
import { listDevices } from '@/modules/mobile/devices'
import { listExports } from '@/modules/tenancy/export'
import { resolveSession, SESSION_COOKIE } from '@/modules/auth/session'
import { SETTINGS_NAV } from '../nav'
import { SecurityBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Security (spec §14, §19).
 *
 * ## Why this page is reachable without a second factor
 *
 * `allowUnenrolled` is passed on purpose. When a company requires MFA, every
 * other page sends its members here — so if this page also demanded MFA the
 * policy would be a lockout with no way out of it.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ enrol?: string }>
}) {
  const actor = await requireActor({ allowUnenrolled: true })
  const session = await requireSession()
  const params = await searchParams

  const cookieStore = await cookies()
  const live = await resolveSession(cookieStore.get(SESSION_COOKIE)?.value)

  const canManagePolicy = can(actor, 'company:manage')
  const canExport = can(actor, 'reports:financial')

  const [mfa, devices, history, policy, failures, exports] = await Promise.all([
    mfaStatus(actor.userId),
    listDevices(actor, live?.deviceId),
    loginHistoryForUser(actor.userId, { limit: 20 }),
    securityPolicy(actor.companyId),
    canManagePolicy ? recentFailuresForCompany(actor.companyId) : Promise.resolve([]),
    canExport ? listExports(actor, { limit: 10 }).catch(() => []) : Promise.resolve([]),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="bookkeeping"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/security" />

      <SecurityBoard
        enrolmentRequired={params.enrol === 'required' && !mfa.enrolled}
        mfa={{
          enrolled: mfa.enrolled,
          confirmedAt: mfa.confirmedAt?.toISOString() ?? null,
          recoveryCodesRemaining: mfa.recoveryCodesRemaining,
        }}
        devices={devices.map((device) => ({
          id: device.id,
          label: device.label,
          platform: device.platform,
          lastSeenAt: device.lastSeenAt.toISOString(),
          isCurrent: device.isCurrent,
          activeSessions: device.activeSessions,
        }))}
        history={history.map((row) => ({
          id: row.id,
          outcome: row.outcome,
          ipPrefix: row.ipPrefix,
          userAgent: row.userAgent,
          createdAt: row.createdAt.toISOString(),
        }))}
        policy={policy}
        failures={failures.map((row) => ({
          email: row.email,
          outcome: row.outcome,
          attempts: Number(row.attempts),
          lastAt: new Date(row.lastAt).toISOString(),
        }))}
        exports={exports.map((row) => ({
          id: row.id,
          datasets: row.datasets,
          rowCount: row.rowCount,
          createdAt: row.createdAt.toISOString(),
        }))}
        canManagePolicy={canManagePolicy}
        canExport={canExport}
      />
    </AppShell>
  )
}
