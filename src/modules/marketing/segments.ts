import { z } from 'zod'

/**
 * Audience segmentation (spec §10).
 *
 * Whether a contact belongs to a segment is a decision about plain values, so
 * it is written as pure functions and tested directly — the same shape as the
 * bookkeeping rules engine. The service layer loads candidates and applies
 * these; nothing here touches a database.
 */

/** The dimensions spec §10 names, plus the ones the CRM already carries. */
export const SEGMENT_FIELDS = [
  'lifecycleStage',
  'industry',
  'region',
  'sizeBand',
  'source',
  'isStrategicAccount',
  'tags',
  /** 'won' | 'lost' | 'open' | 'none' — derived from the opportunity history. */
  'opportunityHistory',
  'emailConsent',
] as const

export type SegmentField = (typeof SEGMENT_FIELDS)[number]

export const SEGMENT_OPERATORS = [
  'is',
  'is_not',
  'in',
  'not_in',
  'contains',
  'is_true',
  'is_false',
  'is_set',
  'is_not_set',
] as const

export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number]

export const segmentRuleSchema = z.object({
  field: z.enum(SEGMENT_FIELDS),
  operator: z.enum(SEGMENT_OPERATORS),
  value: z.union([z.string(), z.boolean(), z.array(z.string())]).optional(),
})

export const segmentDefinitionSchema = z.object({
  /** Whether every rule must hold, or any one of them. */
  matchType: z.enum(['all', 'any']).default('all'),
  rules: z.array(segmentRuleSchema).default([]),
  /**
   * Restricts the audience to contacts on lost or dormant opportunities that
   * were marked marketing-eligible at close (spec §6, §9). This is the
   * lost-opportunity nurture handoff.
   */
  lostOpportunityNurture: z.boolean().default(false),
})

export type SegmentRule = z.infer<typeof segmentRuleSchema>
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>

/** What the matcher sees for one contact. */
export type SegmentCandidate = {
  contactId: string
  email: string | null
  emailConsent: string
  suppressedAt: Date | null
  organizationId: string | null
  /** Display only — merge fields use it; no rule matches on it. */
  organizationName: string | null
  lifecycleStage: string | null
  industry: string | null
  region: string | null
  sizeBand: string | null
  source: string | null
  isStrategicAccount: boolean
  tags: string[]
  /** Best outcome across the organization's opportunities. */
  opportunityHistory: 'won' | 'lost' | 'open' | 'none'
  /** Whether any lost or dormant opportunity was marked eligible at close. */
  marketingEligible: boolean
}

function fieldValue(
  candidate: SegmentCandidate,
  field: SegmentField,
): string | boolean | string[] | null {
  switch (field) {
    case 'lifecycleStage':
      return candidate.lifecycleStage
    case 'industry':
      return candidate.industry
    case 'region':
      return candidate.region
    case 'sizeBand':
      return candidate.sizeBand
    case 'source':
      return candidate.source
    case 'isStrategicAccount':
      return candidate.isStrategicAccount
    case 'tags':
      return candidate.tags
    case 'opportunityHistory':
      return candidate.opportunityHistory
    case 'emailConsent':
      return candidate.emailConsent
    default:
      return null
  }
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).toLowerCase().trim())
  if (value === undefined || value === null) return []
  return [String(value).toLowerCase().trim()]
}

/** Evaluates one rule. String comparisons are case-insensitive and trimmed. */
export function evaluateRule(rule: SegmentRule, candidate: SegmentCandidate): boolean {
  const actual = fieldValue(candidate, rule.field)

  switch (rule.operator) {
    case 'is_set':
      return actual !== null && actual !== '' && !(Array.isArray(actual) && actual.length === 0)
    case 'is_not_set':
      return actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0)
    case 'is_true':
      return actual === true
    case 'is_false':
      return actual === false
    default:
      break
  }

  if (actual === null) return false

  const wanted = asStrings(rule.value)

  // Tags are a list on both sides: "has any of these".
  if (Array.isArray(actual)) {
    const held = actual.map((entry) => entry.toLowerCase().trim())
    switch (rule.operator) {
      case 'contains':
      case 'in':
      case 'is':
        return wanted.some((entry) => held.includes(entry))
      case 'not_in':
      case 'is_not':
        return !wanted.some((entry) => held.includes(entry))
      default:
        return false
    }
  }

  const value = String(actual).toLowerCase().trim()

  switch (rule.operator) {
    case 'is':
      return value === wanted[0]
    case 'is_not':
      return value !== wanted[0]
    case 'in':
      return wanted.includes(value)
    case 'not_in':
      return !wanted.includes(value)
    case 'contains':
      return wanted.length > 0 && value.includes(wanted[0])
    default:
      return false
  }
}

/**
 * Whether a candidate belongs to a segment.
 *
 * A definition with no rules matches everyone — unlike a categorization rule,
 * an empty audience filter is a meaningful "all contacts", and the send
 * pipeline enforces consent regardless of how wide the segment is.
 */
export function matchesSegment(
  definition: SegmentDefinition,
  candidate: SegmentCandidate,
): boolean {
  if (definition.lostOpportunityNurture && !candidate.marketingEligible) return false
  if (definition.rules.length === 0) return true

  return definition.matchType === 'any'
    ? definition.rules.some((rule) => evaluateRule(rule, candidate))
    : definition.rules.every((rule) => evaluateRule(rule, candidate))
}

/** Parses a stored definition, falling back to "everyone" if malformed. */
export function parseDefinition(raw: unknown): SegmentDefinition {
  const parsed = segmentDefinitionSchema.safeParse(raw)
  return parsed.success
    ? parsed.data
    : { matchType: 'all', rules: [], lostOpportunityNurture: false }
}

/**
 * Whether a candidate may actually be emailed (spec §10, §19).
 *
 * Kept separate from segment matching on purpose: a segment describes who you
 * are interested in, consent decides who you are allowed to contact. Mixing
 * the two would let a wide segment quietly imply permission.
 */
export function isContactable(candidate: SegmentCandidate): {
  ok: boolean
  reason?: 'no_email' | 'no_consent' | 'suppressed'
} {
  if (!candidate.email) return { ok: false, reason: 'no_email' }
  if (candidate.suppressedAt) return { ok: false, reason: 'suppressed' }
  if (candidate.emailConsent !== 'subscribed') return { ok: false, reason: 'no_consent' }
  return { ok: true }
}

/** Human-readable summary of a definition, for segment lists. */
export function describeDefinition(definition: SegmentDefinition): string {
  const parts: string[] = []

  if (definition.lostOpportunityNurture) {
    parts.push('lost or dormant deals eligible for nurture')
  }

  for (const rule of definition.rules) {
    const value = Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value ?? '')
    parts.push(`${rule.field} ${rule.operator.replace(/_/g, ' ')} ${value}`.trim())
  }

  if (parts.length === 0) return 'Everyone'
  return parts.join(definition.matchType === 'any' ? ' OR ' : ' AND ')
}
