/** Small presentational pieces shared across the payroll and tax workspace. */

export function Stat({
  label,
  value,
  hint,
  accent,
  tone,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
  tone?: 'good' | 'bad'
}) {
  const toneClass =
    tone === 'good' ? 'text-positive' : tone === 'bad' ? 'text-negative' : accent ? 'text-brand' : ''

  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  )
}

export function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}

export function Table({
  head,
  rows,
}: {
  head: string[]
  rows: Array<Array<React.ReactNode>>
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
        <tr>
          {head.map((label, index) => (
            <th key={label} className={`px-4 py-2 font-medium ${index > 0 ? 'text-right' : ''}`}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-t border-line">
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className={`px-4 py-1.5 ${cellIndex > 0 ? 'tnum text-right' : ''}`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function NoAccess({ role, what }: { role: string; what: string }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold">{what}</h1>
      <p className="mt-2 text-sm text-muted">
        Your role ({role}) does not include access to {what.toLowerCase()}. Payroll is not implied
        by any other permission in this system — what people are paid is the most sensitive data a
        small business holds, so somebody who can see the books does not automatically see it.
      </p>
    </main>
  )
}

/**
 * The spec §19 notice, in the product rather than only in the README.
 *
 * A README nobody reads is not a warning. This sits at the top of every screen
 * in the workspace because the person about to remit against these figures is
 * the person who needs to know the system has not been reviewed for it — and
 * they will never open the repository.
 */
export function SecurityNotice() {
  return (
    <p className="card mb-4 border-warning/40 p-4 text-xs text-muted">
      <span className="font-medium text-warning">Not reviewed for production payroll or tax filing.</span>{' '}
      This workspace records payroll and tax and posts the journal entries for them. It does not
      calculate anybody’s withholding, move money, or submit a return, and spec §19 requires a
      security review before any of that is relied on in production. Figures here are only as good
      as what was entered.
    </p>
  )
}

/** Shown against a run whose figures came from the illustrative adapter. */
export function IllustrativeBadge() {
  return (
    <span
      className="chip bg-warning/15 px-2 py-0.5 text-[11px] text-warning"
      title="Produced by the illustrative adapter: invented flat rates, not any jurisdiction's."
    >
      Illustrative
    </span>
  )
}

/**
 * A tax rate, in full.
 *
 * `formatBasisPoints` rounds to one decimal, which is right for a percent
 * complete and wrong here: a great many real rates are quarter-percents, and
 * showing 8.25% as "8.3%" next to the amount it produced makes the arithmetic
 * look wrong.
 */
export function formatRateBp(bp: number): string {
  const percent = bp / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

/** Signed money, coloured by direction. */
export function Variance({ cents, format }: { cents: number; format: (c: number) => string }) {
  if (cents === 0) return <span className="text-muted">—</span>
  return (
    <span className={cents < 0 ? 'text-negative' : 'text-positive'}>
      {cents > 0 ? '' : '('}
      {format(Math.abs(cents))}
      {cents > 0 ? '' : ')'}
    </span>
  )
}

/** A blocker or a warning from a workpaper pack. */
export function ExceptionRow({
  severity,
  area,
  message,
}: {
  severity: 'blocker' | 'warning'
  area: string
  message: string
}) {
  return (
    <li className="flex gap-3 border-t border-line px-4 py-2 text-sm first:border-t-0">
      <span
        className={`chip mt-0.5 h-fit shrink-0 px-2 py-0.5 text-[11px] ${
          severity === 'blocker' ? 'bg-negative/15 text-negative' : 'bg-warning/15 text-warning'
        }`}
      >
        {severity === 'blocker' ? 'Blocker' : 'Check'}
      </span>
      <span className="min-w-0">
        <span className="text-faint">{area.replace('_', ' ')} · </span>
        {message}
      </span>
    </li>
  )
}
