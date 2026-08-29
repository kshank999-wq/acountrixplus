import Link from 'next/link'
import { logoutAction } from '@/app/actions/auth'
import { can, type ActorContext } from '@/modules/tenancy/context'
import { moduleEnabled } from '@/modules/industry/modules'
import { reachableCompanies } from '@/modules/practice/switching'
import { practicesFor } from '@/modules/practice/service'
import { CompanySwitcher } from './company-switcher'

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
    | 'time'
    | 'properties'
    | 'funds'
    | 'manufacturing'
    | 'takings'
    | 'drawers'
    | 'appointments'
    | 'shop'
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

  const timeEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'time_billing')
    : false

  // Phase 23. Its own workspace for the same reason inventory is: a landlord
  // has units and tenancies and usually no jobs, and burying a rent roll under
  // Accounting is how nobody finds it.
  const propertiesEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'properties')
    : false

  // Phase 26. A charity's funds are the first thing its trustees ask about and
  // the last thing anybody would think to look for under Accounting.
  const fundsEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'funds')
    : false

  // Phase 27. Its own workspace rather than a tab under Inventory: a factory's
  // question is "what is on the floor and what has it cost", and a stock list
  // answers neither.
  const manufacturingEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'manufacturing')
    : false

  // Phase 28. A restaurant's day and a marketplace's settlement are the same
  // shape, so one workspace serves both.
  const takingsEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'pos_import')
    : false

  // Phase 29. A clinic and a salon keep the same diary, so one workspace serves
  // both — and it is gated on the module rather than on either industry.
  const appointmentsEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'appointments')
    : false

  // Phase 30, the tenth module. Its own workspace rather than a tab under Jobs:
  // a garage's question is "what is on the ramp and may I bill it", and a job
  // list answers neither half.
  const shopEnabled = can(actor, 'jobs:view')
    ? await moduleEnabled(actor.companyId, 'vehicles')
    : false

  // Phase 34, the eleventh module. A till this software takes money into, as
  // against Takings, which is a day somebody else's till reported.
  const drawersEnabled = can(actor, 'accounting:view')
    ? await moduleEnabled(actor.companyId, 'cash_drawer')
    : false

  // Practice mode (Phase 18). Both reads are keyed on the user rather than the
  // company, which is the whole point — they are the only two things on this
  // page that are about the person instead of the books they are looking at.
  const [reachable, practices] = await Promise.all([
    reachableCompanies(actor.userId, actor.companyId),
    practicesFor(actor.userId),
  ])

  const links = [
    { key: 'bookkeeping', href: '/bookkeeping', label: 'Bookkeeping', show: can(actor, 'bookkeeping:view') },
    { key: 'accounting', href: '/accounting', label: 'Accounting', show: can(actor, 'accounting:view') },
    { key: 'crm', href: '/crm', label: 'Clients & Sales', show: can(actor, 'crm:view') },
    { key: 'jobs', href: '/jobs', label: 'Jobs', show: jobsEnabled },
    { key: 'inventory', href: '/inventory', label: 'Inventory', show: inventoryEnabled },
    { key: 'time', href: '/time', label: 'Time', show: timeEnabled },
    { key: 'properties', href: '/properties', label: 'Properties', show: propertiesEnabled },
    { key: 'funds', href: '/funds', label: 'Funds', show: fundsEnabled },
    {
      key: 'manufacturing',
      href: '/manufacturing',
      label: 'Manufacturing',
      show: manufacturingEnabled,
    },
    { key: 'takings', href: '/takings', label: 'Takings', show: takingsEnabled },
    { key: 'drawers', href: '/drawers', label: 'Tills', show: drawersEnabled },
    {
      key: 'appointments',
      href: '/appointments',
      label: 'Appointments',
      show: appointmentsEnabled,
    },
    { key: 'shop', href: '/shop', label: 'The shop', show: shopEnabled },
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
      {/*
        Dark chrome over a light workspace, from the design canvas (Phase 70).
        It keeps its own colours in both themes — `chrome-*` rather than `ink`
        — because the nav is a different surface from the page, and following
        the workspace into dark mode would erase the contrast the design is
        built on.
      */}
      <header className="sticky top-0 z-20 bg-chrome text-chrome-ink">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/" className="flex shrink-0 items-baseline gap-1.5">
              <span className="text-[17px] font-bold tracking-tight">Accountrix</span>
              {/* The one place lime is type: on the dark chrome, where the
                  design puts it. Everywhere else the accent-as-text is blue. */}
              <span className="rounded border border-chrome-line px-1 py-0.5 text-[9.5px] font-bold tracking-widest text-brand">
                PLUS
              </span>
            </Link>

            <div className="min-w-0 border-l border-white/10 pl-4">
              <h1 className="truncate text-sm font-semibold tracking-tight">{companyName}</h1>
              <p className="truncate text-xs text-chrome-muted">
                {actor.userName} ({actor.role})
                {actor.viaPractice && (
                  // Shown to the accountant, not to the client. Somebody working
                  // across forty sets of books should never have to wonder which
                  // ones they are in, or on whose authority.
                  <span> · acting for a client via {actor.viaPractice}</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {practices.length > 0 && (
              <Link
                href="/practice"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-chrome-ink transition hover:bg-white/10"
              >
                Practice
              </Link>
            )}
            <CompanySwitcher
              companies={reachable.map((company) => ({
                id: company.id,
                name: company.name,
                role: company.role,
                viaPracticeName: company.viaPracticeName,
                isCurrent: company.isCurrent,
              }))}
              currentName={companyName}
            />
            <form action={logoutAction}>
              <button className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-chrome-ink transition hover:bg-white/10">
                Sign out
              </button>
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
                className={`chip whitespace-nowrap px-3 py-1.5 transition ${
                  active === link.key
                    ? 'bg-brand text-brand-ink'
                    : 'text-chrome-muted hover:bg-white/10 hover:text-chrome-ink'
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
          // On the light workspace, so the selected tab is ink rather than the
          // lime — which only reads on the dark chrome above.
          className={`chip whitespace-nowrap px-3 py-1.5 transition ${
            active === item.href
              ? 'bg-ink text-surface'
              : 'bg-raised text-muted hover:text-ink'
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
