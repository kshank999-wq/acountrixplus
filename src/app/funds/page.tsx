import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled, companyTerminology } from '@/modules/industry/modules'
import { listFinancialAccounts } from '@/modules/banking/sync'
import { listCustomers } from '@/modules/receivables/service'
import { fundBalances, netAssets } from '@/modules/funds/reporting'
import { listContributions, outstandingPledges } from '@/modules/funds/contributions'
import { previewReleases } from '@/modules/funds/releases'
import { FundsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The funds workspace (spec §5 Nonprofit, Phase 26).
 *
 * Gated on the module rather than the industry, the same as properties: a
 * community sports club on the "general" pack that runs a restricted building
 * appeal has funds, and a charity that only ever receives unrestricted money
 * genuinely does not need this screen.
 */
export default async function FundsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Funds</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to funds.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'funds'))) {
    return (
      <AppShell
        actor={actor}
        companyName={session?.companyName ?? 'Accountrix Plus'}
        active="funds"
      >
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Fund accounting is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-brand hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to track what money was given for, and release restriction as it is spent.
          </p>
        </div>
      </AppShell>
    )
  }

  const params = await searchParams
  const today = new Date().toISOString().slice(0, 10)
  const month = params.month ?? `${today.slice(0, 7)}-01`

  const [balances, assets, preview, pledges, contributions, donors, accounts, terms] =
    await Promise.all([
      fundBalances(actor, { asOf: today }),
      // Net assets is the whole charity's position, so it follows the same
      // permission as every other financial statement rather than the softer
      // one that opens the fund list.
      can(actor, 'reports:financial') ? netAssets(actor, { asOf: today }) : null,
      previewReleases(actor, { month }),
      outstandingPledges(actor),
      listContributions(actor, { limit: 40 }),
      listCustomers(actor),
      listFinancialAccounts(actor),
      companyTerminology(actor.companyId),
    ])

  return (
    <AppShell actor={actor} companyName={session?.companyName ?? 'Accountrix Plus'} active="funds">
      <FundsBoard
        month={month}
        balances={balances}
        netAssets={assets}
        preview={preview}
        pledges={pledges.map((pledge) => ({
          id: pledge.id,
          fundCode: pledge.fundCode,
          fundName: pledge.fundName,
          donorName: pledge.donorName,
          receivedOn: pledge.receivedOn,
          amountCents: pledge.amountCents,
          receivedCents: pledge.receivedCents,
          outstandingCents: pledge.outstandingCents,
        }))}
        contributions={contributions.map((row) => ({
          id: row.id,
          fundCode: row.fundCode,
          fundName: row.fundName,
          donorName: row.donorName,
          kind: row.kind,
          receivedOn: row.receivedOn,
          amountCents: row.amountCents,
          outstandingCents: row.outstandingCents,
          memo: row.memo,
        }))}
        donors={donors.map((donor) => ({ id: donor.id, name: donor.name }))}
        accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
        // The nonprofit pack renames a customer to a Donor (spec §5). The
        // record is the same `customers` row either way — only the word moves.
        donorWord={terms.customer}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
