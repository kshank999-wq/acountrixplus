/**
 * Turning what somebody typed into what the ledger stores.
 *
 * Pure. Every function returns `null` on failure rather than throwing or
 * guessing, because the caller is validating four hundred rows at once and
 * wants all the problems, not the first one.
 *
 * The rule throughout: **refuse rather than guess.** An import that silently
 * reads `03/04/2026` as March when the file meant April produces books that
 * are wrong in a way nobody will find, and "we imported it and it looked
 * fine" is how that survives to the year end.
 */

/**
 * Money as written by a person or an accounting package, into integer cents.
 *
 * Handles, because real exports contain all of them:
 *
 *   1234.56    $1,234.56    1,234.56 USD     — ordinary
 *   (1,234.56)                               — accounting negatives
 *   -1234.56   1234.56-                      — leading and trailing minus
 *   1234       1,234.5                       — short or absent decimals
 *   ""         "-"                           — an empty cell, and a dash
 *
 * Returns `null` for anything else. In particular it refuses `1.234,56`: a
 * European-formatted file and a US one are indistinguishable at `1.234` — is
 * that one thousand two hundred and thirty-four, or one and a bit? — and a
 * fifty-fifty guess about somebody's money is not a guess worth making.
 */
export function parseMoneyCents(raw: string): number | null {
  let text = raw.trim()
  if (text === '' || text === '-' || text === '—') return null

  let negative = false

  // Accounting parentheses.
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1).trim()
  }

  // Currency symbols and codes, either end.
  text = text.replace(/^[A-Z]{3}\s*/i, '').replace(/\s*[A-Z]{3}$/i, '')
  text = text.replace(/[$£€¥]/g, '').trim()

  if (text.startsWith('-')) {
    negative = !negative
    text = text.slice(1).trim()
  } else if (text.endsWith('-')) {
    negative = !negative
    text = text.slice(0, -1).trim()
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim()
  }

  if (text === '') return null

  // A comma is a thousands separator only where a thousands separator can go.
  // `1,23` is not a number anybody means, and reading it as 123 would turn
  // $1.23 into $123.00.
  if (text.includes(',')) {
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(text)) return null
    text = text.replace(/,/g, '')
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null

  // More than two decimal places is a rate or a quantity, not an amount of
  // money. Rounding it would silently discard precision the file thought
  // mattered.
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > 2) return null

  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents)) return null

  return negative ? -cents : cents
}

/** Which way round an ambiguous numeric date should be read. */
export type DateOrder = 'mdy' | 'dmy'

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * A date as written, into `YYYY-MM-DD`.
 *
 * ISO is read as ISO. A date with a spelled-out month is unambiguous and read
 * directly. A purely numeric date is read according to `order`, which the
 * import wizard asks for and defaults to `mdy` — **and the wizard shows a
 * sample row parsed both ways**, because this is the single most damaging
 * silent failure in any import: half a year of transactions landing in the
 * wrong month, all of them plausible, none of them flagged.
 *
 * A two-digit year is windowed at 70: `69` is 2069 and `70` is 1970. Arbitrary
 * and conventional; a bookkeeping file from 1969 is not the case to optimise
 * for.
 */
export function parseDateISO(raw: string, order: DateOrder = 'mdy'): string | null {
  const text = raw.trim()
  if (text === '') return null

  // 2026-03-17, and 2026/03/17 which some exports use.
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  // 17-Mar-2026, Mar 17 2026, 17 March 2026.
  const named = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-,]+(\d{2,4})$/.exec(text)
  if (named) {
    const month = MONTHS[named[2].slice(0, 4).toLowerCase()] ?? MONTHS[named[2].slice(0, 3).toLowerCase()]
    return month ? build(year(named[3]), month, Number(named[1])) : null
  }

  const namedFirst = /^([A-Za-z]{3,9})[\s-]+(\d{1,2})[\s-,]+(\d{2,4})$/.exec(text)
  if (namedFirst) {
    const month =
      MONTHS[namedFirst[1].slice(0, 4).toLowerCase()] ?? MONTHS[namedFirst[1].slice(0, 3).toLowerCase()]
    return month ? build(year(namedFirst[3]), month, Number(namedFirst[2])) : null
  }

  // Purely numeric: 03/17/2026, 17.03.2026, 3-17-26.
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text)
  if (numeric) {
    const a = Number(numeric[1])
    const b = Number(numeric[2])
    const y = year(numeric[3])

    // One of them settling it beats the setting: 25/03 can only be a day and a
    // month whatever the user picked, and honouring a wrong setting here would
    // reject a row that is not ambiguous at all.
    if (a > 12 && b <= 12) return build(y, b, a)
    if (b > 12 && a <= 12) return build(y, a, b)

    return order === 'mdy' ? build(y, a, b) : build(y, b, a)
  }

  return null

  function year(text: string): number {
    const value = Number(text)
    if (text.length === 4) return value
    return value >= 70 ? 1900 + value : 2000 + value
  }

  /** Rejects 31 February rather than rolling it into March. */
  function build(y: number, m: number, d: number): string | null {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    if (d > last) return null
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
}

/**
 * True when a numeric date could mean two different days.
 *
 * Used to warn before an import runs, not to reject one. If every date in a
 * file has a component above twelve there is nothing to ask about.
 */
export function isAmbiguousDate(raw: string): boolean {
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(raw.trim())
  if (!numeric) return false
  const a = Number(numeric[1])
  const b = Number(numeric[2])
  return a <= 12 && b <= 12 && a !== b
}

/** `yes`, `y`, `true`, `1`, `x` and their opposites. `null` if neither. */
export function parseBoolean(raw: string): boolean | null {
  const text = raw.trim().toLowerCase()
  if (text === '') return null
  if (['y', 'yes', 'true', 't', '1', 'x', '✓'].includes(text)) return true
  if (['n', 'no', 'false', 'f', '0', '-'].includes(text)) return false
  return null
}

/** Collapses runs of whitespace and trims. `" Acme   Ltd "` → `"Acme Ltd"`. */
export function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * A rough email check, used to warn rather than to reject.
 *
 * Deliberately permissive: a customer whose email is wrong is still a customer
 * worth importing, and refusing the row would lose the balance they owe.
 */
export function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())
}
