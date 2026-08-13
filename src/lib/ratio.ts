/**
 * Ratios as basis points.
 *
 * Percentages are integers here for the same reason money is: 33.33% stored as
 * a float and multiplied back out does not give the number anyone expects.
 * One basis point is a hundredth of a percent, so 10% is 1000 and 100% is
 * 10,000 — enough precision for a retainage clause or a percent complete, with
 * no floating point anywhere near a stored value.
 *
 * Lives in `lib` rather than a domain module because both server code and
 * client components need it, and a client component that reaches into a module
 * touching the database drags the Postgres driver into the browser bundle.
 */

export function basisPoints(part: number, whole: number): number {
  if (whole === 0) return 0
  return Math.round((part / whole) * 10_000)
}

export function formatBasisPoints(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`
}
