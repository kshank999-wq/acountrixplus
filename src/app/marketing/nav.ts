/** Sub-navigation for the marketing workspace (spec §2, §10). */
export const MARKETING_NAV = [
  { href: '/marketing', label: 'Overview' },
  { href: '/marketing/campaigns', label: 'Campaigns' },
  { href: '/marketing/segments', label: 'Segments' },
  { href: '/marketing/creative', label: 'Creative' },
  { href: '/marketing/suppressions', label: 'Suppressions' },
]

/** Human-readable names for the engagement event kinds (spec §10). */
export const EVENT_LABELS: Record<string, string> = {
  sent: 'Sent',
  open: 'Opened',
  click: 'Clicked',
  bounce: 'Bounced',
  unsubscribe: 'Unsubscribed',
}
