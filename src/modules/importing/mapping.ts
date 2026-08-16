/**
 * Matching somebody else's column names to ours.
 *
 * Pure. The mapping is always *proposed* and never applied on its own — the
 * wizard shows what it guessed and the user confirms or changes it, because a
 * confident wrong guess about which column is the amount is worse than no
 * guess at all.
 */

export type FieldSpec = {
  key: string
  /** Shown in the wizard. */
  label: string
  required: boolean
  /** Header names, lowercased, that mean this field elsewhere. */
  aliases: string[]
  hint?: string
}

/** Normalizes a header for comparison: `"Account #"` → `"account"`. */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(no|num|number|nbr|#)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * How well a header matches one field, 0 to 100.
 *
 * Exact alias beats prefix beats containment. Containment is scored low and
 * capped deliberately: "Account" is contained in both "Account Number" and
 * "Bank Account", and a containment match is a hint rather than an answer.
 */
export function scoreHeader(header: string, field: FieldSpec): number {
  const normalized = normalizeHeader(header)
  if (normalized === '') return 0

  const candidates = [normalizeHeader(field.key), normalizeHeader(field.label), ...field.aliases.map(normalizeHeader)]

  let best = 0
  for (const candidate of candidates) {
    if (candidate === '') continue
    if (normalized === candidate) best = Math.max(best, 100)
    else if (normalized.startsWith(candidate) || candidate.startsWith(normalized)) {
      best = Math.max(best, 70)
    } else if (normalized.includes(candidate) || candidate.includes(normalized)) {
      best = Math.max(best, 40)
    }
  }

  return best
}

export type ProposedMapping = {
  /** field key → header, or null when nothing matched well enough. */
  columns: Record<string, string | null>
  /** Headers no field claimed. Shown so a user can spot a missed column. */
  unmatchedHeaders: string[]
  /** Required fields with no column. The import cannot run until these are set. */
  missingRequired: string[]
}

/** Below this a match is a coincidence, not a suggestion. */
const MATCH_FLOOR = 40

/**
 * Proposes a column for each field.
 *
 * Assigns greedily from the strongest match down, and **one header serves one
 * field**. Without that, a file with `Debit` and `Credit` columns can have both
 * claimed by an `amount` field that scores 40 against each, and the second
 * column silently disappears from the import.
 */
export function proposeMapping(headers: string[], fields: FieldSpec[]): ProposedMapping {
  const pairs: Array<{ field: string; header: string; score: number }> = []

  for (const field of fields) {
    for (const header of headers) {
      const score = scoreHeader(header, field)
      if (score >= MATCH_FLOOR) pairs.push({ field: field.key, header, score })
    }
  }

  // Strongest first; ties broken by column order so the result is stable
  // rather than dependent on the order fields happen to be declared in.
  pairs.sort(
    (a, b) => b.score - a.score || headers.indexOf(a.header) - headers.indexOf(b.header),
  )

  const columns: Record<string, string | null> = {}
  for (const field of fields) columns[field.key] = null

  const takenHeaders = new Set<string>()

  for (const pair of pairs) {
    if (columns[pair.field] !== null) continue
    if (takenHeaders.has(pair.header)) continue
    columns[pair.field] = pair.header
    takenHeaders.add(pair.header)
  }

  return {
    columns,
    unmatchedHeaders: headers.filter((header) => header !== '' && !takenHeaders.has(header)),
    missingRequired: fields
      .filter((field) => field.required && columns[field.key] === null)
      .map((field) => field.key),
  }
}

/** Reads a mapped field out of a row record. Empty string when unmapped. */
export function valueFor(
  record: Record<string, string>,
  columns: Record<string, string | null>,
  fieldKey: string,
): string {
  const header = columns[fieldKey]
  if (!header) return ''
  return record[header] ?? ''
}

// --- The field sets each importer accepts ----------------------------------

export const ACCOUNT_FIELDS: FieldSpec[] = [
  {
    key: 'number',
    label: 'Account number',
    required: true,
    aliases: ['acct', 'code', 'account code', 'gl code', 'gl'],
  },
  { key: 'name', label: 'Account name', required: true, aliases: ['description', 'title', 'account'] },
  {
    key: 'type',
    label: 'Type',
    required: true,
    aliases: ['account type', 'category', 'classification', 'class'],
    hint: 'Asset, Liability, Equity, Revenue, COGS, Expense.',
  },
  { key: 'subtype', label: 'Detail type', required: false, aliases: ['detail type', 'sub type', 'subaccount type'] },
  { key: 'description', label: 'Description', required: false, aliases: ['notes', 'memo'] },
]

export const CONTACT_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', required: true, aliases: ['company', 'customer', 'vendor', 'supplier', 'display name', 'company name'] },
  { key: 'email', label: 'Email', required: false, aliases: ['e mail', 'email address', 'main email'] },
  { key: 'phone', label: 'Phone', required: false, aliases: ['telephone', 'main phone', 'phone number'] },
  { key: 'taxId', label: 'Tax ID', required: false, aliases: ['ein', 'tin', 'vat', 'tax number', 'abn'] },
  { key: 'addressLine1', label: 'Address', required: false, aliases: ['street', 'address 1', 'billing address', 'bill address line1'] },
  { key: 'city', label: 'City', required: false, aliases: ['town', 'bill address city'] },
  { key: 'region', label: 'State', required: false, aliases: ['province', 'county', 'bill address state'] },
  { key: 'postalCode', label: 'Postal code', required: false, aliases: ['zip', 'postcode', 'bill address postal code'] },
]

export const TRIAL_BALANCE_FIELDS: FieldSpec[] = [
  { key: 'number', label: 'Account number', required: true, aliases: ['acct', 'code', 'gl code', 'gl'] },
  {
    key: 'debit',
    label: 'Debit',
    required: false,
    aliases: ['debits', 'dr', 'debit amount'],
    hint: 'Either a debit and credit pair, or one signed balance column.',
  },
  { key: 'credit', label: 'Credit', required: false, aliases: ['credits', 'cr', 'credit amount'] },
  {
    key: 'balance',
    label: 'Balance',
    required: false,
    aliases: ['amount', 'ending balance', 'closing balance', 'opening balance'],
    hint: 'Signed: positive is a debit, negative is a credit.',
  },
  { key: 'name', label: 'Account name', required: false, aliases: ['description', 'account'] },
]

export const OPEN_DOCUMENT_FIELDS: FieldSpec[] = [
  { key: 'party', label: 'Customer or vendor', required: true, aliases: ['customer', 'vendor', 'supplier', 'name', 'company'] },
  { key: 'number', label: 'Document number', required: true, aliases: ['invoice', 'invoice no', 'bill no', 'doc number', 'reference', 'ref'] },
  { key: 'date', label: 'Date', required: true, aliases: ['issue date', 'invoice date', 'bill date', 'txn date', 'transaction date'] },
  { key: 'dueDate', label: 'Due date', required: false, aliases: ['due', 'terms date'] },
  {
    key: 'amount',
    label: 'Amount outstanding',
    required: true,
    aliases: ['balance', 'open balance', 'amount due', 'outstanding', 'total'],
    hint: 'What is still owed, not what the document was originally for.',
  },
  { key: 'memo', label: 'Memo', required: false, aliases: ['description', 'notes'] },
]
