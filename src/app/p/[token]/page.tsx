import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { formatCents } from '@/lib/money'
import { proposalByToken, recordView } from '@/modules/crm/proposals'
import { truncateIp } from '@/modules/crm/intake'

export const dynamic = 'force-dynamic'

/**
 * The client-facing proposal link (spec §7, §9).
 *
 * Unauthenticated and read-only: the token grants a view of exactly one
 * proposal. Opening the page records a view, which is what feeds the
 * open-tracking figures in spec §9 — coarse by design, since §9 qualifies view
 * tracking with "where technically and legally appropriate".
 */
export default async function PublicProposalPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const view = await proposalByToken(token)
  if (!view) notFound()

  const headerStore = await headers()
  await recordView(token, {
    ipPrefix: truncateIp(
      headerStore.get('x-forwarded-for') ?? headerStore.get('x-real-ip'),
    ),
    userAgent: headerStore.get('user-agent'),
  })

  const { proposal, organizationName, items } = view
  const billable = items.filter((item) => !item.isOptional || item.isSelected)
  const optional = items.filter((item) => item.isOptional && !item.isSelected)

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-16">
      <header className="mb-8 border-b border-line pb-6">
        <p className="tnum text-xs uppercase tracking-wide text-muted">{proposal.number}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {proposal.title}
        </h1>
        <p className="mt-1 text-sm text-muted">Prepared for {organizationName}</p>
        {proposal.expiresOn && (
          <p className="mt-3 text-xs text-warning">Valid through {proposal.expiresOn}</p>
        )}
      </header>

      {proposal.executiveSummary && (
        <Section title="Summary">{proposal.executiveSummary}</Section>
      )}
      {proposal.scope && <Section title="Scope of work">{proposal.scope}</Section>}
      {proposal.exclusions && <Section title="Exclusions">{proposal.exclusions}</Section>}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Pricing
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {billable.map((item) => (
                <tr key={item.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">{item.description}</td>
                  <td className="tnum whitespace-nowrap px-4 py-2.5 text-right">
                    {formatCents(item.amountCents)}
                  </td>
                </tr>
              ))}

              {proposal.discountCents > 0 && (
                <tr className="border-b border-line">
                  <td className="px-4 py-2.5 text-muted">Discount</td>
                  <td className="tnum px-4 py-2.5 text-right text-muted">
                    −{formatCents(proposal.discountCents)}
                  </td>
                </tr>
              )}
              {proposal.taxCents > 0 && (
                <tr className="border-b border-line">
                  <td className="px-4 py-2.5 text-muted">Tax</td>
                  <td className="tnum px-4 py-2.5 text-right text-muted">
                    {formatCents(proposal.taxCents)}
                  </td>
                </tr>
              )}

              <tr className="bg-raised/60 text-base font-semibold">
                <td className="px-4 py-3">Total</td>
                <td className="tnum px-4 py-3 text-right">{formatCents(proposal.totalCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {optional.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Optional additions
            </h3>
            <ul className="card divide-y divide-line text-sm">
              {optional.map((item) => (
                <li key={item.id} className="flex justify-between gap-4 px-4 py-2.5">
                  <span>{item.description}</span>
                  <span className="tnum shrink-0 text-muted">
                    {formatCents(item.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {proposal.terms && <Section title="Terms">{proposal.terms}</Section>}

      <footer className="mt-10 border-t border-line pt-6 text-xs text-faint">
        <p>
          Questions about this proposal? Reply to the message it came with and we will get back
          to you.
        </p>
      </footer>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="whitespace-pre-wrap text-sm leading-relaxed">{children}</div>
    </section>
  )
}
