import Link from 'next/link'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listEmployees } from '@/modules/payroll/service'
import { getPayrollProvider, payrollProviderStatus } from '@/modules/payroll/provider'
import { payrollNav } from '../nav'
import { NoAccess, SecurityNotice } from '../ui'
import { RunWizard } from './wizard'

export const dynamic = 'force-dynamic'

/**
 * The payroll run wizard (spec §13).
 *
 * Built around one requirement: nobody posts payroll from this screen without
 * having seen the journal entry it produces. A totals row looks the same
 * whether withholding was treated as an employer cost or not — the entry is
 * the only place the difference shows, so the entry is a step rather than a
 * detail somebody can open afterwards.
 */
export default async function RunPayrollPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'payroll:run')) return <NoAccess role={actor.role} what="Payroll" />

  const people = await listEmployees(actor, { activeOnly: true })
  const provider = getPayrollProvider()

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="payroll"
    >
      <SubNav items={payrollNav(actor)} active="/payroll/run" />
      <SecurityNotice />

      {people.length === 0 ? (
        <section className="card p-8 text-center">
          <h2 className="text-sm font-semibold">Nobody on payroll yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Add the people you pay first. A run needs at least one of them, and the run wizard
            works from their pay basis and rate.
          </p>
          <Link href="/payroll/people" className="btn mt-4 inline-block text-xs">
            Add people
          </Link>
        </section>
      ) : (
        <RunWizard
          people={people.map((person) => ({
            id: person.id,
            name: person.name,
            payBasis: person.payBasis as 'salary' | 'hourly',
            baseRateCents: person.baseRateCents,
          }))}
          providers={payrollProviderStatus()}
          activeProviderKey={provider.key}
        />
      )}
    </AppShell>
  )
}
