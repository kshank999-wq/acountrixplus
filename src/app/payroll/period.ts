/**
 * Default reporting periods for the workspace.
 *
 * Computed from today rather than hardcoded, and kept in one place so the
 * overview, the workpapers, and the returns cannot quietly disagree about
 * which year "this year" is.
 */

function today(): Date {
  return new Date()
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function yearToDate(): { startDate: string; endDate: string } {
  const now = today()
  return {
    startDate: `${now.getUTCFullYear()}-01-01`,
    endDate: iso(now),
  }
}

export function currentYear(): number {
  return today().getUTCFullYear()
}

/** The quarter containing today, which is the commonest sales tax period. */
export function currentQuarter(): { periodStart: string; periodEnd: string; label: string } {
  const now = today()
  const year = now.getUTCFullYear()
  const quarter = Math.floor(now.getUTCMonth() / 3)
  const startMonth = quarter * 3
  const endMonth = startMonth + 2

  const lastDay = new Date(Date.UTC(year, endMonth + 1, 0)).getUTCDate()

  return {
    periodStart: `${year}-${String(startMonth + 1).padStart(2, '0')}-01`,
    periodEnd: `${year}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    label: `Q${quarter + 1} ${year}`,
  }
}
