import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { ServiceWorker } from './service-worker'

/**
 * The mobile app's shell (spec §3, §18).
 *
 * A separate route tree from the desktop workspaces rather than a responsive
 * variant of them. Phase 1 already made the inbox responsive, and it works —
 * but "the desktop app, narrower" and "the thing you open in a queue for
 * coffee" are different products. This one has three destinations, thumb-sized
 * targets, and no navigation chrome competing with the content.
 *
 * The desktop app is still there and still complete; `/m` is a second door for
 * the two-minute visit.
 */
export default async function MobileLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor()

  // Unauthenticated visitors go to the ordinary login page, which returns them
  // here. The mobile app has no separate credential — same origin, same signed
  // cookie, one authentication path to get right.
  if (!actor) redirect('/login?next=/m')

  const session = await currentSession()

  const tabs = [
    { href: '/m', label: 'Today', icon: HomeIcon },
    { href: '/m/review', label: 'Review', icon: ReviewIcon, show: can(actor, 'bookkeeping:view') },
    { href: '/m/receipt', label: 'Receipt', icon: CameraIcon, show: can(actor, 'bookkeeping:categorize') },
    { href: '/m/settings', label: 'Settings', icon: GearIcon },
  ].filter((tab) => tab.show !== false)

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <ServiceWorker />

      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        {/* Padded for the notch: `viewport-fit=cover` puts the page under it. */}
        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {session?.companyName ?? 'Accountrix Plus'}
            </p>
            <p className="truncate text-xs text-muted">{actor.userName}</p>
          </div>
          <Link href="/bookkeeping" className="chip bg-raised px-2 py-1 text-xs text-muted">
            Full app
          </Link>
        </div>
      </header>

      <main className="flex-1 px-4 py-4">{children}</main>

      {/*
        A bottom bar, not a top one. On a phone the top of the screen is the
        hardest place to reach one-handed, and this app is used one-handed.
      */}
      <nav className="sticky bottom-0 z-20 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="flex">
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              // 56px tall: comfortably above the 44px minimum touch target,
              // because this is the control people hit while walking.
              className="flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted transition active:bg-raised"
            >
              <tab.icon />
              <span>{tab.label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  )
}

/* Inline SVGs rather than an icon package: four icons is not worth a
   dependency, and these ship in the HTML instead of a second request. */

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 9.5V20h13V9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ReviewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M8 10.5h8M8 14.5h5" strokeLinecap="round" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="M4 8.5h3l1.5-2h7L17 8.5h3v11H4z" strokeLinejoin="round" />
      <circle cx="12" cy="13.5" r="3.2" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
