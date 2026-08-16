/**
 * What an import would do, worked out before it does any of it.
 *
 * ## The claim: nothing is imported until all of it can be
 *
 * Every importer builds a plan first. The plan carries every row's parsed
 * value or its problems, and `canCommit` is false if a single row has an
 * error. Committing then writes the whole file inside one transaction.
 *
 * The alternative — write as you go, stop on the first bad row — is how an
 * import leaves a company with 137 of 400 customers and no way to tell which
 * 137 without reading both files side by side. Worse on a trial balance: a
 * half-posted opening balance is an unbalanced ledger, and the tool that
 * caused it is the tool they would have to use to find it.
 *
 * A **warning** is different from an error and does not block. A customer with
 * a malformed email address is still a customer worth importing, and refusing
 * the row would lose the balance they owe.
 */

export type Severity = 'error' | 'warning'

export type RowProblem = {
  /** 1-based data row, not counting the header — what the user sees in Excel. */
  row: number
  field?: string
  message: string
  severity: Severity
}

export type PlannedRow<T> = {
  row: number
  /** Null when the row could not be parsed at all. */
  parsed: T | null
  /** What committing this row would do. */
  action: 'create' | 'update' | 'skip'
  problems: RowProblem[]
}

export type PlanCounts = {
  total: number
  willCreate: number
  willUpdate: number
  willSkip: number
  errors: number
  warnings: number
}

export type ImportPlan<T> = {
  headers: string[]
  columns: Record<string, string | null>
  delimiter: string
  rows: Array<PlannedRow<T>>
  /** Problems with the file as a whole rather than one row. */
  fileProblems: RowProblem[]
  counts: PlanCounts
  /** False if anything at all is an error. See the module note. */
  canCommit: boolean
  blankRowsSkipped: number
}

export function countPlan<T>(
  rows: Array<PlannedRow<T>>,
  fileProblems: RowProblem[],
): PlanCounts {
  const rowProblems = rows.flatMap((row) => row.problems)
  const all = [...rowProblems, ...fileProblems]

  return {
    total: rows.length,
    willCreate: rows.filter((row) => row.action === 'create').length,
    willUpdate: rows.filter((row) => row.action === 'update').length,
    willSkip: rows.filter((row) => row.action === 'skip').length,
    errors: all.filter((problem) => problem.severity === 'error').length,
    warnings: all.filter((problem) => problem.severity === 'warning').length,
  }
}

export function finishPlan<T>(
  base: Omit<ImportPlan<T>, 'counts' | 'canCommit'>,
): ImportPlan<T> {
  const counts = countPlan(base.rows, base.fileProblems)
  return {
    ...base,
    counts,
    // One error anywhere stops the whole file. See the module note.
    canCommit: counts.errors === 0 && counts.total > 0,
  }
}

/** Raised when a commit is attempted on a plan that has errors. */
export class ImportNotReadyError extends Error {
  readonly status = 422
  constructor(readonly errors: number) {
    super(
      errors === 0
        ? 'There is nothing in this file to import.'
        : `${errors} ${errors === 1 ? 'row has a problem' : 'rows have problems'} that must be ` +
          'fixed first. Nothing was imported — an import goes in whole or not at all.',
    )
    this.name = 'ImportNotReadyError'
  }
}

/**
 * A shortened, de-duplicated problem list for a message or a stored note.
 *
 * Four hundred rows missing the same column produce four hundred identical
 * problems, and a user needs to read "400 rows have no account number", not
 * scroll past four hundred of them to find the one that says something else.
 */
export function summarizeProblems(problems: RowProblem[], limit = 8): string[] {
  const byMessage = new Map<string, number[]>()

  for (const problem of problems) {
    const rows = byMessage.get(problem.message) ?? []
    rows.push(problem.row)
    byMessage.set(problem.message, rows)
  }

  const lines = [...byMessage.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit)
    .map(([message, rows]) =>
      rows.length === 1
        ? `Row ${rows[0]}: ${message}`
        : `${rows.length} rows: ${message} (first at row ${Math.min(...rows)})`,
    )

  const remaining = byMessage.size - lines.length
  if (remaining > 0) lines.push(`…and ${remaining} other kinds of problem.`)

  return lines
}
