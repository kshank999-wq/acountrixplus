import type { RuleCondition, RuleOperator } from '@/db/schema'

/**
 * Pure rule matching (spec §3).
 *
 * Deliberately free of database access: whether a rule matches a transaction
 * is a decision about two plain values, so it is written as a pure function
 * and tested directly. The service layer handles loading and persistence.
 */

/** The subset of a transaction a rule can see. */
export type MatchableTransaction = {
  description: string
  merchantName: string | null
  amountCents: number
  financialAccountId: string
}

export type MatchableRule = {
  id: string
  matchType: 'all' | 'any'
  conditions: RuleCondition[]
  /** When set, the rule only applies to this bank account. */
  financialAccountId?: string | null
  isActive?: boolean
  priority?: number
}

/** Resolves the transaction value a condition refers to. */
function fieldValue(
  transaction: MatchableTransaction,
  field: RuleCondition['field'],
): string | number | null {
  switch (field) {
    case 'description':
      return transaction.description
    case 'merchantName':
      return transaction.merchantName
    case 'amountCents':
      return transaction.amountCents
    case 'absAmountCents':
      return Math.abs(transaction.amountCents)
    case 'financialAccountId':
      return transaction.financialAccountId
    case 'direction':
      return transaction.amountCents < 0 ? 'debit' : 'credit'
    default:
      return null
  }
}

const NUMERIC_OPERATORS: RuleOperator[] = ['gt', 'gte', 'lt', 'lte']

/**
 * Evaluates one condition.
 *
 * String comparisons are case-insensitive and trimmed, because bank
 * descriptions arrive in inconsistent casing ("SHELL OIL" vs "Shell Oil") and
 * users should not have to think about that when writing a rule.
 */
export function evaluateCondition(
  condition: RuleCondition,
  transaction: MatchableTransaction,
): boolean {
  const actual = fieldValue(transaction, condition.field)
  if (actual === null || actual === undefined) return false

  if (NUMERIC_OPERATORS.includes(condition.operator)) {
    const left = Number(actual)
    const right = Number(condition.value)
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false

    switch (condition.operator) {
      case 'gt':
        return left > right
      case 'gte':
        return left >= right
      case 'lt':
        return left < right
      case 'lte':
        return left <= right
      default:
        return false
    }
  }

  // Numeric equality stays numeric so 100 and "100" agree.
  if (typeof actual === 'number' || typeof condition.value === 'number') {
    const left = Number(actual)
    const right = Number(condition.value)
    if (Number.isFinite(left) && Number.isFinite(right)) {
      switch (condition.operator) {
        case 'equals':
          return left === right
        case 'not_equals':
          return left !== right
        default:
          break
      }
    }
  }

  const left = String(actual).toLowerCase().trim()
  const right = String(condition.value).toLowerCase().trim()

  switch (condition.operator) {
    case 'contains':
      return left.includes(right)
    case 'not_contains':
      return !left.includes(right)
    case 'equals':
      return left === right
    case 'not_equals':
      return left !== right
    case 'starts_with':
      return left.startsWith(right)
    case 'ends_with':
      return left.endsWith(right)
    default:
      return false
  }
}

/**
 * Whether a rule matches a transaction.
 *
 * A rule with no conditions never matches. An empty condition list would
 * otherwise vacuously satisfy `every()` and silently recategorize the entire
 * inbox — the wrong default for a financial system.
 */
export function matchesRule(rule: MatchableRule, transaction: MatchableTransaction): boolean {
  if (rule.isActive === false) return false
  if (rule.conditions.length === 0) return false

  if (rule.financialAccountId && rule.financialAccountId !== transaction.financialAccountId) {
    return false
  }

  return rule.matchType === 'any'
    ? rule.conditions.some((c) => evaluateCondition(c, transaction))
    : rule.conditions.every((c) => evaluateCondition(c, transaction))
}

/**
 * Picks the winning rule for a transaction: lowest `priority` wins, ties break
 * on the order supplied (callers pass rules oldest-first, so the
 * longest-standing rule wins a tie).
 */
export function firstMatchingRule<T extends MatchableRule>(
  rules: T[],
  transaction: MatchableTransaction,
): T | null {
  let best: T | null = null
  let bestPriority = Number.POSITIVE_INFINITY

  for (const rule of rules) {
    if (!matchesRule(rule, transaction)) continue

    const priority = rule.priority ?? 100
    if (priority < bestPriority) {
      best = rule
      bestPriority = priority
    }
  }

  return best
}

/**
 * Normalizes a bank descriptor into a stable merchant key.
 *
 * Feeds append store numbers, reference ids, and dates to otherwise identical
 * descriptions ("SHELL OIL 574839", "SHELL OIL 118204"). Stripping those makes
 * the recurring vendor recognisable across months, which is what vendor memory
 * (spec §3) depends on.
 */
export function normalizeMerchant(description: string, merchantName?: string | null): string {
  const source = merchantName?.trim() || description

  return source
    .toLowerCase()
    // Card/reference noise.
    .replace(/\b(?:pos|ach|debit|credit|purchase|payment|pmt|recurring|autopay)\b/g, ' ')
    // Long digit runs are store/reference numbers.
    .replace(/[#*]?\d{3,}/g, ' ')
    // Dates in the descriptor.
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9\s&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Builds the conditions for a vendor-memory rule: match this merchant again.
 * Returns null when the descriptor normalizes to something too short to be a
 * safe match — a two-character key would match far too much.
 */
export function vendorMemoryConditions(
  description: string,
  merchantName?: string | null,
): RuleCondition[] | null {
  const key = normalizeMerchant(description, merchantName)
  if (key.length < 3) return null

  return [{ field: 'description', operator: 'contains', value: key }]
}
