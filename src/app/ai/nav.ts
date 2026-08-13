/** Sub-navigation for the AI module (spec §2, §11). */
export const AI_NAV = [
  { href: '/ai', label: 'Overview' },
  { href: '/ai/insights', label: 'Insights' },
  { href: '/ai/prompts', label: 'Prompts' },
]

/** Human-readable names for the capabilities spec §11 lists. */
export const FEATURE_LABELS: Record<string, string> = {
  bookkeeping_categorize: 'Category suggestions',
  bookkeeping_anomalies: 'Anomaly review',
  bookkeeping_rule: 'Rule proposals',
  bookkeeping_summary: 'Inbox summaries',
  reconciliation_explain: 'Reconciliation help',
  proposal_draft: 'Proposal writer',
  marketing_draft: 'Marketing writer',
  business_insights: 'Business insights',
}

export const OUTCOME_LABELS: Record<string, string> = {
  ok: 'Answered',
  invalid_output: 'Unusable output',
  provider_error: 'Provider error',
  refused: 'Declined',
  blocked_quota: 'Blocked — quota',
  blocked_disabled: 'Blocked — switched off',
}
