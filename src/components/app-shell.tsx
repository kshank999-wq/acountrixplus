import Link from 'next/link'
import { logoutAction } from '@/app/actions/auth'
import { can, type ActorContext } from '@/modules/tenancy/context'
import { moduleEnabled } from '@/modules/industry/modules'

/**
 * Chrome shared by the workspaces (spec §2).
 *
 * Navigation is filtered by permission, so a role that cannot open a workspace
 * is not shown a link into it in the first place.
 */
export async function AppShell({
  actor,
  companyName,
  active,
  actions,
  children,
}: {
  actor: ActorContext
  companyName: string
  active:
    | 'bookkeeping'
    | 'accounting'
    | 'crm'
    | 'jobs'
    | 'inventory'
    | 'payroll'
    | 'marketing'
    | 'studio'
    | 'ai'
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  // Industry modules are per company (spec §5, §23), so the workspace either
  // exists for this tenant or it does not appear at all. A permanently
  // greyed-out link to a workspace you did not ask for is an advert.
  const jobsEnabled = can(actor, 'jobs:view')
    ? await moduleEnabled(actor.companyId, 'job_costing')
    : false

  // Its own workspace rather than a tab under Jobs (Phase 14). A retailer has
  // stock and no jobs; a contractor has jobs and often no stock. Nesting one
  // inside the other would hide it from half the companies that need it.
  const inventoryEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'inventory')
    : false

  const links = [
    { key: 'bookkeeping', href: '/bookkeeping', label: 'Bookkeeping', show: can(actor, 'bookkeeping:view') },
    { key: 'accounting', href: '/accounting', label: 'Accounting', show: can(actor, 'accounting:view') },
    { key: 'crm', href: '/crm', label: 'Clients & Sales', show: can(actor, 'crm:view') },
    { key: 'jobs', href: '/jobs', label: 'Jobs', show: jobsEnabled },
    { key: 'inventory', href: '/inventory', label: 'Inventory', show: inventoryEnabled },
    // Either half opens the workspace: a bookkeeper who handles sales tax but
    // not wages has `tax:view` without `payroll:view`, and the sub-navigation
    // hides what they cannot see rather than the whole workspace.
    {
      key: 'payroll',
      href: can(actor, 'payroll:view') ? '/payroll' : '/payroll/sales-tax',
      label: 'Payroll & Tax',
      show: can(actor, 'payroll:view') || can(actor, 'tax:view'),
    },
    { key: 'marketing', href: '/marketing', label: 'Marketing', show: can(actor, 'marketing:view') },
    { key: 'studio', href: '/studio', label: 'Company Studio', show: can(actor, 'crm:view') },
    // Last, and only for those who administer it: the AI module is additive
    // (spec §23), so it should never be the first thing a workspace offers.
    { key: 'ai', href: '/ai', label: 'AI', show: can(actor, 'ai:manage') },
  ].filter((link) => link.show)

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">{companyName}</h1>
            <p className="truncate text-xs text-muted">
              {actor.userName} ({actor.role})
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <form action={logoutAction}>
              <button className="btn text-xs">Sign out</button>
            </form>
          </div>
        </div>

        {/*
          The workspace row scrolls rather than wraps: with five workspaces it
          no longer fits a phone, and a chip whose label breaks across two lines
          is harder to read than one you swipe to.
        */}
        {links.length > 1 && (
          <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
            {links.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                className={`chip whitespace-nowrap px-3 py-1.5 ${
                  active === link.key
                    ? 'bg-brand text-brand-ink'
                    : 'bg-raised text-muted hover:text-ink'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}

/** Sub-navigation within the accounting workspace. */
export function SubNav({
  items,
  active,
}: {
  items: Array<{ href: string; label: string }>
  active: string
}) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`chip whitespace-nowrap px-3 py-1.5 ${
            active === item.href
              ? 'bg-brand text-brand-ink'
              : 'bg-raised text-muted hover:text-ink'
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
