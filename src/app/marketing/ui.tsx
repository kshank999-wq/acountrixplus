/** Small presentational pieces shared across the marketing workspace. */

export function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${accent ? 'text-action' : ''}`}>{value}</p>
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
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
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

/** Denied-access notice, so every page in the workspace says the same thing. */
export function NoAccess({ role, what }: { role: string; what: string }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold">{what}</h1>
      <p className="mt-2 text-sm text-muted">
        Your role ({role}) does not include access to marketing.
      </p>
    </main>
  )
}
