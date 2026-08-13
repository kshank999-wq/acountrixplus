import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import {
  liabilityPositions,
  listRemittances,
  remittanceAccounts,
} from '@/modules/payroll/remittance'
import { payrollNav } from '../nav'
import { Card, Empty, NoAccess, SecurityNotice, Table } from '../ui'
import { yearToDate } from '../period'
import { RemittanceForm } from './form'

export const dynamic = 'force-dynamic'

/**
 * What is owed to agencies, and recording that it was paid (spec §13).
 *
 * The positions come from the ledger rather than from the payroll runs. A
 * figure somebody is about to pay an agency has to come from the same place
 * the balance sheet gets it, or the two disagree at the worst possible moment.
 */
export default async function LiabilitiesPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'tax:view')) return <NoAccess role={actor.role} what="Tax" />

  const period = yearToDate()

  const [positions, remittances, banks] = await Promise.all([
    liabilityPositions(actor, { asOfDate: period.endDate }),
    listRemittances(actor, { limit: 25 }),
    remittanceAccounts(actor),
  ])

  const canRemit = can(actor, 'tax:manage') && can(actor, 'accounting:journal')

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="payroll"
    >
      <SubNav items={payrollNav(actor)} active="/payroll/liabilities" />
      <SecurityNotice />

      <Card
        title="Owed to agencies"
        subtitle={`As at ${period.endDate}, from posted journal lines. A remittance clears the debt — it is not an expense, because the cost was recognised when the payroll ran or the sale was made.`}
      >
        {positions.length === 0 ? (
          <Empty>
            Nothing accrued. These accounts appear once payroll has been run or sales tax charged.
          </Empty>
        ) : (
          <Table
            head={['Account', 'Accrued', 'Remitted', 'Still owed']}
            rows={positions.map((entry) => [
              <span key={entry.accountId}>
                <span className="font-medium">{entry.accountNumber}</span>{' '}
                <span className="text-muted">{entry.accountName}</span>
              </span>,
              formatCents(entry.accruedCents),
              formatCents(entry.remittedCents),
              <span
                key="b"
                className={entry.balanceCents < 0 ? 'text-negative' : undefined}
                title={
                  entry.balanceCents < 0
                    ? 'Negative: more has been remitted than was ever accrued.'
                    : undefined
                }
              >
                {formatCents(entry.balanceCents)}
              </span>,
            ])}
          />
        )}
      </Card>

      {canRemit && (
        <div className="mt-4">
          <RemittanceForm
            positions={positions.map((entry) => ({
              accountId: entry.accountId,
              accountNumber: entry.accountNumber,
              accountName: entry.accountName,
              balanceCents: entry.balanceCents,
            }))}
            banks={banks}
          />
        </div>
      )}

      <div className="mt-4">
        <Card
          title="Remittances recorded"
          subtitle="A record that somebody paid an agency. This system does not move money."
        >
          {remittances.length === 0 ? (
            <Empty>Nothing remitted yet.</Empty>
          ) : (
            <Table
              head={['Paid on', 'Agency', 'Kind', 'Period', 'Account', 'Amount', 'Reference']}
              rows={remittances.map((entry) => [
                entry.paidOn,
                entry.agency,
                <span key="k" className="text-muted">
                  {entry.kind === 'sales_tax' ? 'sales tax' : 'payroll'}
                </span>,
                <span key="p" className="text-muted">
                  {entry.periodStart} → {entry.periodEnd}
                </span>,
                <span key="a" className="text-muted">
                  {entry.accountNumber} {entry.accountName}
                </span>,
                formatCents(entry.amountCents),
                entry.reference ?? '—',
              ])}
            />
          )}
        </Card>
      </div>
    </AppShell>
  )
}
