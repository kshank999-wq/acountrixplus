/** Sub-navigation for the settings area. */
export const SETTINGS_NAV = [
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/access', label: 'Who has access' },
  { href: '/settings/modules', label: 'Modules' },
  { href: '/settings/accounts', label: 'Bank accounts' },
  // The chart itself had no screen until Phase 118 — read as a dropdown in
  // nine places and managed in none.
  { href: '/settings/chart', label: 'Chart of accounts' },
  { href: '/settings/chasing', label: 'Chasing' },
  { href: '/settings/statements', label: 'Statements' },
  { href: '/settings/payments', label: 'Card payments' },
  { href: '/settings/import', label: 'Bring in your books' },
  { href: '/settings/operations', label: 'Background work' },
]
