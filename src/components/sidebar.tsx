'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Icon, type IconName } from './nav-icons'
import { CompanySwitcher } from './company-switcher'

/**
 * The workspace rail, from the design canvas.
 *
 * ## Why a rail rather than the row it replaced
 *
 * The chrome carried its navigation as a horizontal strip of chips. That was
 * fine at five workspaces. There are seventeen, they are per-company, and the
 * strip had already been given `overflow-x-auto` — which is to say: the answer
 * to "which workspaces does this company have" was *swipe sideways and find
 * out*. A vertical rail shows all of them at once, in a column that has room
 * for a label, an icon and a count.
 *
 * ## What is a client component and why
 *
 * Only the opening and closing. The links themselves are decided on the
 * server, by permission and by which industry modules the company has turned
 * on, and arrive here as data — the rail cannot show a workspace somebody may
 * not open, because it is never told about one.
 */

export type NavLink = {
  key: string
  href: string
  label: string
  icon: IconName
}

export function Sidebar({
  links,
  active,
  companyName,
  userName,
  role,
  viaPractice,
  showPractice,
  companies,
  signOut,
}: {
  links: NavLink[]
  active: string
  companyName: string
  userName: string
  role: string
  viaPractice?: string | null
  showPractice: boolean
  companies: Array<{
    id: string
    name: string
    role: string
    viaPracticeName: string | null
    isCurrent: boolean
  }>
  /** The sign-out form, rendered on the server so the action stays there. */
  signOut: React.ReactNode
}) {
  const [open, setOpen] = useState(false)

  // Closing on navigation. Without this the panel stays over the page somebody
  // just asked for, on the one screen size where it covers all of it.
  useEffect(() => {
    setOpen(false)
  }, [active])

  return (
    <>
      {/* The phone's top bar: the rail is off-canvas until asked for. */}
      <div className="sticky top-0 z-30 flex items-center gap-3 bg-chrome px-4 py-3 text-chrome-ink lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg p-1.5 transition hover:bg-white/10"
          aria-label="Open the workspace menu"
        >
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <Wordmark />
        <span className="ml-auto truncate text-xs text-chrome-muted">{companyName}</span>
      </div>

      {open && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setOpen(false)}
          aria-label="Close the workspace menu"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col bg-chrome text-chrome-ink transition-transform lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 px-5 pb-4 pt-5">
          <Wordmark />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto rounded-lg p-1 transition hover:bg-white/10 lg:hidden"
            aria-label="Close the workspace menu"
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        <p className="px-5 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-chrome-muted">
          Workspace
        </p>

        {/* The rail scrolls, not the page. Seventeen workspaces is taller than
            a laptop, and the account card below has to stay put. */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          {links.map((link) => {
            const current = active === link.key
            return (
              <Link
                key={link.key}
                href={link.href}
                aria-current={current ? 'page' : undefined}
                className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                  current
                    ? 'bg-white/[0.07] font-medium text-chrome-ink'
                    : 'text-chrome-muted hover:bg-white/5 hover:text-chrome-ink'
                }`}
              >
                {/* The lime, in the one place the design shouts on this rail. */}
                {current && (
                  <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand" />
                )}
                <Icon name={link.icon} />
                <span className="truncate">{link.label}</span>
              </Link>
            )
          })}
        </nav>

        {/*
          Whose books these are, at the foot of the rail rather than in a
          header. It is the question somebody asks when they are about to type
          a number into the wrong company's ledger, and it belongs where the
          eye ends up rather than where it starts.
        */}
        <div className="m-3 rounded-xl bg-chrome-raised p-3.5">
          <p className="truncate text-sm font-semibold tracking-tight">{companyName}</p>
          <p className="mt-0.5 truncate text-xs text-chrome-muted">
            {userName} · {role}
          </p>
          {viaPractice && (
            // Shown to the accountant, not to the client. Somebody working
            // across forty sets of books should never have to wonder which
            // ones they are in, or on whose authority.
            <p className="mt-1 text-xs text-brand">acting for a client via {viaPractice}</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <CompanySwitcher companies={companies} currentName={companyName} />
            {showPractice && (
              <Link
                href="/practice"
                className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs font-medium text-chrome-ink transition hover:bg-white/10"
              >
                Practice
              </Link>
            )}
            {signOut}
          </div>
        </div>
      </aside>
    </>
  )
}

function Wordmark() {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-[13px] font-bold text-brand-ink">
        A+
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[15px] font-bold tracking-tight">Accountrix</span>
        {/* The one place lime is type: on the dark rail, where the design
            puts it. Everywhere else the accent-as-text is blue. */}
        <span className="rounded border border-chrome-line px-1 py-0.5 text-[9px] font-bold tracking-widest text-brand">
          PLUS
        </span>
      </span>
    </Link>
  )
}
