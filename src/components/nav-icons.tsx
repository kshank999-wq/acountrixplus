/**
 * The sidebar's icon set.
 *
 * Hand-drawn paths rather than an icon package. Seventeen glyphs at sixteen
 * pixels is not worth a dependency, and every icon here is one this
 * application actually navigates to — an icon library brings four thousand
 * that it does not.
 *
 * All of them are drawn on the same 24-unit grid with the same stroke weight,
 * so they sit on one optical line down the rail. `currentColor` throughout, so
 * a nav item's state colours its icon without the icon knowing about states.
 */

export type IconName =
  | 'overview'
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
  | 'practice'
  | 'menu'
  | 'close'

const PATHS: Record<IconName, React.ReactNode> = {
  // A four-pane dashboard.
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  // Two arrows passing: money in, money out.
  bookkeeping: (
    <>
      <path d="M4 8h13l-3-3" />
      <path d="M20 16H7l3 3" />
    </>
  ),
  // A ledger page.
  accounting: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  // Two people.
  crm: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8M17 20a5.5 5.5 0 0 0-2-4.3" />
    </>
  ),
  // A site plan.
  jobs: (
    <>
      <path d="M3 20h18" />
      <path d="M6 20V9l6-4 6 4v11" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  // A carton.
  inventory: (
    <>
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    </>
  ),
  // A clock.
  time: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  // A building with windows.
  properties: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />
    </>
  ),
  // A hand holding something given.
  funds: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-3 4.5-4.5 8-4.5s6.5 1.5 8 4.5" />
    </>
  ),
  // A works, with a chimney.
  manufacturing: (
    <>
      <path d="M3 21V11l5 3V11l5 3V11l5 3V7h3v14z" />
    </>
  ),
  // A till receipt.
  takings: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9.5 8h5M9.5 12h5" />
    </>
  ),
  // A cash drawer.
  drawers: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 12h18M10 15h4" />
    </>
  ),
  // A diary page.
  appointments: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  // A vehicle on a ramp.
  shop: (
    <>
      <path d="M4 16h16" />
      <path d="M5.5 16 7 10h10l1.5 6" />
      <circle cx="8" cy="18.5" r="1.6" />
      <circle cx="16" cy="18.5" r="1.6" />
    </>
  ),
  // A pay packet.
  payroll: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18M8 3l4 3 4-3" />
    </>
  ),
  // A megaphone.
  marketing: (
    <>
      <path d="M4 10v4a1 1 0 0 0 1 1h3l7 4V5L8 9H5a1 1 0 0 0-1 1z" />
      <path d="M18.5 9.5a4 4 0 0 1 0 5" />
    </>
  ),
  // A drawing compass and page — the design surface.
  studio: (
    <>
      <circle cx="12" cy="5" r="2" />
      <path d="M11 7 6 20M13 7l5 13" />
      <path d="M8.6 15h6.8" />
    </>
  ),
  // A spark.
  ai: (
    <>
      <path d="M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2z" />
    </>
  ),
  // A firm's portfolio of clients.
  practice: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
}

export function Icon({ name, className = 'h-4 w-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
