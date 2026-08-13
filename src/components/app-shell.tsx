import Link from 'next/link'
import { logoutAction } from '@/app/actions/auth'
import { can, type ActorContext } from '@/modules/tenancy/context'

/**
 * Chrome shared by the workspaces (spec §2).
 *
 * Navigation is filtered by permission, so a role that cannot open a workspace
 * is not shown a link into it in the first place.
 */
export function AppShell({
  actor,
  companyName,
  active,
  actions,
  children,
}: {
  actor: ActorContext
  companyName: string
  active: 'bookkeeping' | 'accounting' | 'crm'
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const links = [
    { key: 'bookkeeping', href: '/bookkeeping', label: 'Bookkeeping', show: can(actor, 'bookkeeping:view') },
    { key: 'accounting', href: '/accounting', label: 'Accounting', show: can(actor, 'accounting:view') },
    { key: 'crm', href: '/crm', label: 'Clients & Sales', show: can(actor, 'crm:view') },
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

        {links.length > 1 && (
          <nav className="mx-auto flex max-w-7xl gap-1 px-4 pb-2 sm:px-6">
            {links.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                className={`chip px-3 py-1.5 ${
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
