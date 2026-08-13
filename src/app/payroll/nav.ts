import { can, type ActorContext } from '@/modules/tenancy/context'

/**
 * Sub-navigation for the payroll and tax workspace (spec §2, §13).
 *
 * Filtered rather than fixed, because the two halves are separately permitted:
 * a bookkeeper handles sales tax and contractor reporting without ever seeing
 * what anybody is paid. A greyed-out "People" link would leak the fact that
 * there is payroll to see.
 */
export function payrollNav(actor: ActorContext) {
  const payroll = can(actor, 'payroll:view')
  const tax = can(actor, 'tax:view')

  return [
    { href: '/payroll', label: 'Overview', show: payroll },
    { href: '/payroll/people', label: 'People', show: payroll },
    { href: '/payroll/run', label: 'Run payroll', show: can(actor, 'payroll:run') },
    { href: '/payroll/liabilities', label: 'Liabilities', show: tax },
    { href: '/payroll/sales-tax', label: 'Sales tax', show: tax },
    { href: '/payroll/contractors', label: 'Contractors', show: tax },
    { href: '/payroll/workpapers', label: 'Workpapers', show: tax },
  ]
    .filter((item) => item.show)
    .map(({ href, label }) => ({ href, label }))
}
