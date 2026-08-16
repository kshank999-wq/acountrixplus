/**
 * Reading a file somebody exported from their old accounting system
 * (spec §20 Phase 8, "advanced integrations").
 *
 * Pure — no database, no filesystem. Everything here can be checked against a
 * string literal, which matters because the inputs are not written by us and
 * not written by a program we can fix. They come out of QuickBooks, Xero, Sage,
 * a bank, or a spreadsheet somebody has been keeping since 2011, and every one
 * of them has a different idea of what a CSV is.
 *
 * ## Why not a library
 *
 * A parser is a hundred lines and the failure modes are all in the *data*,
 * not the algorithm: a memo containing a comma, an address containing a
 * newline, a file that starts with a byte-order mark, a European export using
 * semicolons. Those are the cases the tests are about, and they are cases a
 * dependency would also have to be tested against before being trusted with
 * somebody's books.
 */

/** Raised when a file cannot be read as delimited text at all. */
export class MalformedFileError extends Error {
  readonly status = 422
  constructor(
    message: string,
    /** 1-based, for a message somebody can act on. */
    readonly line?: number,
  ) {
    super(message)
    this.name = 'MalformedFileError'
  }
}

/**
 * Strips a UTF-8 byte-order mark.
 *
 * Excel writes one on every CSV it saves. Left in place it becomes part of the
 * first header, so `Account` arrives as `﻿Account`, the column mapping
 * silently fails to match it, and the user is told their file has no Account
 * column while looking at a file that plainly does.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

const DELIMITERS = [',', '\t', ';', '|'] as const
export type Delimiter = (typeof DELIMITERS)[number]

/**
 * Guesses the delimiter from the first few lines.
 *
 * Counts candidates *outside quotes* and picks the one whose count is most
 * consistent across lines, not the one that appears most. A file of addresses
 * separated by tabs has more commas than tabs — "Portland, OR" in every row —
 * and counting raw frequency picks the comma every time and shreds the file.
 */
export function sniffDelimiter(text: string): Delimiter {
  const sample = stripBom(text).split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 20)
  if (sample.length === 0) return ','

  let best: Delimiter = ','
  let bestScore = -1

  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter))
    const first = counts[0]
    if (first === 0) continue

    // Consistency beats frequency: every row of a well-formed file has the
    // same number of separators.
    const consistent = counts.filter((count) => count === first).length / counts.length
    const score = consistent * 100 + Math.min(first, 20)

    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }

  return best
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1
      else inQuotes = !inQuotes
    } else if (char === delimiter && !inQuotes) {
      count += 1
    }
  }

  return count
}

/**
 * Parses delimited text into rows of raw strings.
 *
 * Follows RFC 4180: fields may be quoted, a quote inside a quoted field is
 * doubled, and a quoted field may contain the delimiter or a newline. Both
 * CRLF and LF line endings work, including a file that mixes them — which
 * happens whenever somebody opens a Unix export in Excel and saves it.
 *
 * Whitespace is **not** trimmed here. A leading space might be significant in
 * an account name, and the place to decide that is the coercion step where the
 * target type is known.
 */
export function parseDelimited(text: string, delimiter?: Delimiter): string[][] {
  const source = stripBom(text)
  const sep = delimiter ?? sniffDelimiter(source)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  // Distinguishes an empty last field from no field at all, so `a,b,` yields
  // three fields and a trailing newline yields no extra row.
  let fieldStarted = false

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        if (char === '\n') line += 1
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      fieldStarted = true
      continue
    }

    if (char === sep) {
      row.push(field)
      field = ''
      fieldStarted = false
      continue
    }

    if (char === '\r') {
      // Swallow CR only when it precedes LF; a lone CR is a Mac Classic line
      // ending and is treated as one too.
      if (source[i + 1] === '\n') continue
      pushRow()
      continue
    }

    if (char === '\n') {
      pushRow()
      continue
    }

    field += char
    fieldStarted = true
  }

  if (inQuotes) {
    throw new MalformedFileError(
      'A quoted value is never closed — there is an odd number of quote marks in the file.',
      line,
    )
  }

  if (field !== '' || fieldStarted || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows

  function pushRow() {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
    fieldStarted = false
    line += 1
  }
}

export type Sheet = {
  /** The header row, as written in the file. */
  headers: string[]
  /** Data rows, padded or trimmed to the header count. */
  rows: string[][]
  delimiter: Delimiter
  /** Rows dropped because every cell was empty. */
  blankRowsSkipped: number
}

/**
 * Turns delimited text into a header row plus data rows.
 *
 * Two accommodations for real files, both of which sound sloppy and are not:
 *
 *  - **Blank rows are dropped.** Exports routinely carry them between sections,
 *    and a spreadsheet saved from Excel often has hundreds at the end where
 *    somebody once clicked. Reporting 400 errors for "row is empty" buries the
 *    one real problem.
 *  - **Short rows are padded and long rows are reported.** A row with fewer
 *    cells than headers is usually trailing empties the exporter omitted. A row
 *    with *more* is a genuine sign the file is misaligned, so it is a problem
 *    rather than a silent truncation.
 */
export function readSheet(text: string, delimiter?: Delimiter): Sheet {
  const sep = delimiter ?? sniffDelimiter(text)
  const raw = parseDelimited(text, sep)

  const nonEmpty = raw.filter((row) => row.some((cell) => cell.trim() !== ''))
  if (nonEmpty.length === 0) {
    throw new MalformedFileError('There is nothing in this file.')
  }

  const [headerRow, ...dataRows] = nonEmpty
  const headers = headerRow.map((header) => header.trim())

  if (headers.every((header) => header === '')) {
    throw new MalformedFileError('The first row is empty, so there are no column names to read.')
  }

  return {
    headers,
    rows: dataRows.map((row) =>
      row.length === headers.length
        ? row
        : Array.from({ length: headers.length }, (_, i) => row[i] ?? ''),
    ),
    delimiter: sep,
    blankRowsSkipped: raw.length - nonEmpty.length,
  }
}

/** The cells of a row, keyed by trimmed header. Later duplicates lose. */
export function rowToRecord(headers: string[], row: string[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (let i = 0; i < headers.length; i += 1) {
    const key = headers[i]
    if (key === '' || key in record) continue
    record[key] = row[i] ?? ''
  }
  return record
}
