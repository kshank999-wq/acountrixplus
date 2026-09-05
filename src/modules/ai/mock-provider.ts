import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  ModelPricing,
} from './provider'

/**
 * A provider that answers from heuristics instead of a model (spec §22).
 *
 * The default, and the reason the demo, the seed, and the entire test suite
 * run with no API key and no network. It is not a stub that returns fixed
 * text: it reads the same structured input a real adapter would be given and
 * computes a genuinely useful answer — a category from the merchant name, an
 * anomaly from the amount distribution, a draft from the company's own
 * service catalog.
 *
 * That matters beyond convenience. Everything downstream of the provider —
 * schema validation, the suggestion queue, the approval flow, metering — is
 * exercised end to end by the tests, because the mock produces output of the
 * same shape a model does. A stub returning `{}` would have left all of it
 * untested.
 *
 * It is deliberately deterministic. The same input gives the same answer, so
 * a test asserting on a suggestion is asserting on behaviour rather than on
 * whatever a model happened to say that day.
 */
export class MockAiProvider implements AiProvider {
  readonly key = 'mock'
  readonly defaultModel = 'mock-heuristic-v1'

  /** Recorded calls, so a test can assert what would have been sent. */
  readonly calls: CompletionRequest[] = []

  private failNext = false

  isConfigured(): boolean {
    return true
  }

  /** Free. The ledger still records the call so metering is exercised. */
  pricing(): ModelPricing {
    return {
      inputPerMillionMicros: 0,
      outputPerMillionMicros: 0,
      cachedInputPerMillionMicros: 0,
    }
  }

  /** Makes the next call fail, for exercising the error path. */
  failOnce(): void {
    this.failNext = true
  }

  reset(): void {
    this.calls.length = 0
    this.failNext = false
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request)

    const usage = {
      // Roughly four characters per token — enough for the ledger to show
      // realistic figures without pretending to be a real tokenizer.
      inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4),
      outputTokens: 120,
      cachedInputTokens: 0,
    }

    if (this.failNext) {
      this.failNext = false
      return {
        ok: false,
        kind: 'error',
        message: 'Mock provider failure',
        model: this.defaultModel,
        usage,
        retryable: true,
      }
    }

    const output = answerFor(request)

    if (output === null) {
      return {
        ok: false,
        kind: 'error',
        message: `The mock provider has no heuristic for "${request.feature}".`,
        model: this.defaultModel,
        usage,
        retryable: false,
      }
    }

    return { ok: true, output, model: this.defaultModel, usage }
  }
}

// --- Heuristics ------------------------------------------------------------

function answerFor(request: CompletionRequest): unknown {
  switch (request.feature) {
    case 'bookkeeping_categorize':
      return categorize(request.input)
    case 'bookkeeping_anomalies':
      return anomalies(request.input)
    case 'bookkeeping_rule':
      return proposeRule(request.input)
    case 'bookkeeping_summary':
      return summarize(request.input)
    case 'reconciliation_explain':
      return explainReconciliation(request.input)
    case 'proposal_draft':
      return draftProposal(request.input)
    case 'marketing_draft':
      return draftCampaign(request.input)
    case 'business_insights':
      return businessInsights(request.input)
    default:
      return null
  }
}

type AccountOption = { id: string; number: string; name: string }

/**
 * Keyword hints, ordered most specific first.
 *
 * Deliberately small and readable. This is the mock's whole "intelligence",
 * and a reader should be able to predict its answer.
 */
const CATEGORY_HINTS: Array<{ match: RegExp; accountNumbers: string[]; why: string }> = [
  { match: /shell|chevron|exxon|bp |fuel|gas station/i, accountNumbers: ['6800'], why: 'fuel purchase' },
  { match: /home depot|lowes|builder|lumber|supply/i, accountNumbers: ['5110'], why: 'materials supplier' },
  { match: /rent|property|leasing/i, accountNumbers: ['6400'], why: 'recurring rent' },
  { match: /insur/i, accountNumbers: ['6600'], why: 'insurance premium' },
  { match: /payroll|wages|salary/i, accountNumbers: ['6000'], why: 'payroll run' },
  { match: /verizon|at&t|comcast|internet|phone/i, accountNumbers: ['6700'], why: 'utilities or telecoms' },
  { match: /subcontract|electric|plumb|hvac/i, accountNumbers: ['5130'], why: 'subcontracted work' },
  { match: /bank|service charge|fee/i, accountNumbers: ['6900'], why: 'bank charge' },
]

function categorize(input: Record<string, unknown>): unknown {
  const description = String(input.description ?? '')
  const merchant = String(input.merchantName ?? '')
  const amountCents = Number(input.amountCents ?? 0)
  const accounts = (input.accounts as AccountOption[] | undefined) ?? []
  const haystack = `${merchant} ${description}`

  // Money in is revenue; the hints below are all spending.
  if (amountCents > 0) {
    const revenue = accounts.find((account) => account.number.startsWith('4'))
    if (!revenue) return null
    return {
      chartAccountId: revenue.id,
      confidenceBp: 6000,
      rationale: `A deposit of this kind is usually revenue, so ${revenue.name} is the likely account. Confirm before posting.`,
    }
  }

  for (const hint of CATEGORY_HINTS) {
    if (!hint.match.test(haystack)) continue

    const account = accounts.find((option) => hint.accountNumbers.includes(option.number))
    if (!account) continue

    return {
      chartAccountId: account.id,
      confidenceBp: 8500,
      rationale: `"${merchant || description}" reads as a ${hint.why}, which belongs in ${account.name}.`,
    }
  }

  return {
    chartAccountId: null,
    confidenceBp: 0,
    rationale: 'Nothing in the description identifies this reliably. Better categorized by hand.',
  }
}

type TransactionSample = {
  id: string
  description: string
  merchantName: string | null
  amountCents: number
  postedDate: string
}

/**
 * Duplicates and outliers (spec §11 "identify likely duplicates/anomalies").
 *
 * Two rules, both explainable to the person reading the result: the same
 * merchant and amount within three days, and a spend far above this
 * merchant's own typical size.
 */
function anomalies(input: Record<string, unknown>): unknown {
  const rows = (input.transactions as TransactionSample[] | undefined) ?? []
  const findings: Array<Record<string, unknown>> = []

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]
      const b = rows[j]
      if (a.amountCents !== b.amountCents) continue
      if ((a.merchantName ?? a.description) !== (b.merchantName ?? b.description)) continue

      const days = Math.abs(
        (Date.parse(a.postedDate) - Date.parse(b.postedDate)) / 86_400_000,
      )
      if (days > 3) continue

      findings.push({
        kind: 'duplicate',
        transactionIds: [a.id, b.id],
        severity: 'high',
        explanation: `Two charges of the same amount from ${a.merchantName ?? a.description} within ${Math.round(days)} day(s). Often one payment recorded twice.`,
      })
    }
  }

  // Outliers, per merchant, against that merchant's own median.
  const byMerchant = new Map<string, TransactionSample[]>()
  for (const row of rows) {
    const key = (row.merchantName ?? row.description).toLowerCase()
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), row])
  }

  for (const [merchant, group] of byMerchant) {
    if (group.length < 3) continue

    const amounts = group.map((row) => Math.abs(row.amountCents)).sort((a, b) => a - b)
    const median = amounts[Math.floor(amounts.length / 2)]
    if (median === 0) continue

    for (const row of group) {
      if (Math.abs(row.amountCents) < median * 4) continue

      findings.push({
        kind: 'outlier',
        transactionIds: [row.id],
        severity: 'medium',
        explanation: `This is several times the usual charge from ${merchant}. Worth a look before it is categorized with the rest.`,
      })
    }
  }

  return { findings: findings.slice(0, 20) }
}

/** A rule proposal from a repeated, consistently categorized merchant. */
function proposeRule(input: Record<string, unknown>): unknown {
  const merchant = String(input.merchantName ?? input.description ?? '').trim()
  const accountName = String(input.accountName ?? 'the chosen account')
  const occurrences = Number(input.occurrences ?? 0)

  if (!merchant) return null

  // The distinctive part of a merchant string, without the store number and
  // location a card network appends.
  const token = merchant.split(/[\s#*]+/).filter((part) => part.length > 2)[0] ?? merchant

  return {
    name: `${token} to ${accountName}`,
    field: 'merchantName',
    operator: 'contains',
    value: token,
    action: occurrences >= 4 ? 'auto' : 'suggest',
    confidenceBp: occurrences >= 4 ? 8000 : 5500,
    rationale:
      occurrences >= 4
        ? `${occurrences} transactions matching "${token}" went to ${accountName}. A rule would categorize these on arrival.`
        : `"${token}" has come up ${occurrences} times. A suggesting rule keeps you in the loop until the pattern is clearer.`,
  }
}

function summarize(input: Record<string, unknown>): unknown {
  const count = Number(input.uncategorizedCount ?? 0)
  const totals = (input.uncategorizedTotals as Array<{ currency: string; cents: number }>) ?? []
  const topMerchants = (input.topMerchants as Array<{ name: string; count: number }>) ?? []

  const lead =
    count === 0
      ? 'The inbox is clear — everything imported has been categorized.'
      : `${count} transaction${count === 1 ? '' : 's'} are waiting, worth ` +
        `${totals.map((row) => formatCentsPlain(Math.abs(row.cents), row.currency)).join(' and ')} in total.`

  const detail = topMerchants
    .slice(0, 3)
    .map((entry) => `${entry.name} (${entry.count})`)
    .join(', ')

  return {
    summary: detail ? `${lead} Most of them are from ${detail}.` : lead,
    suggestedNextStep:
      count === 0
        ? 'Nothing to do here. Reconciling the month is the next useful step.'
        : topMerchants.length > 0
          ? `Start with ${topMerchants[0].name} — categorizing one and saving a rule clears the rest.`
          : 'Work down from the largest amounts; they matter most to the accounts.',
  }
}

function explainReconciliation(input: Record<string, unknown>): unknown {
  const differenceCents = Number(input.differenceCents ?? 0)
  const unclearedCount = Number(input.unclearedCount ?? 0)
  const candidates = (input.candidates as TransactionSample[] | undefined) ?? []

  if (differenceCents === 0) {
    return {
      explanation: 'The statement and the ledger agree. Nothing outstanding.',
      likelyCauses: [],
      suggestedTransactionIds: [],
    }
  }

  const exact = candidates.filter((row) => row.amountCents === differenceCents)
  const causes: string[] = []

  if (exact.length > 0) {
    causes.push(
      `One uncleared transaction matches the difference exactly — ${exact[0].description}. Clearing it would balance the session.`,
    )
  }
  if (unclearedCount > 0) {
    causes.push(
      `${unclearedCount} transaction${unclearedCount === 1 ? ' has' : 's have'} not been ticked off yet. The difference may simply be those.`,
    )
  }
  // A difference divisible by 9 is the classic transposition signature.
  if (Math.abs(differenceCents) % 9 === 0) {
    causes.push(
      'The difference divides by 9, which usually means two digits were entered the wrong way round.',
    )
  }
  if (causes.length === 0) {
    causes.push(
      'Nothing on this statement accounts for it. A missing transaction or a bank fee not yet imported is the usual reason.',
    )
  }

  return {
    explanation: `The statement is out by ${formatCentsPlain(Math.abs(differenceCents))}.`,
    likelyCauses: causes,
    suggestedTransactionIds: exact.slice(0, 5).map((row) => row.id),
  }
}

function draftProposal(input: Record<string, unknown>): unknown {
  const clientName = String(input.clientName ?? 'the client')
  const title = String(input.opportunityTitle ?? 'the project')
  const companyName = String(input.companyName ?? 'we')
  const services = (input.services as Array<{ name: string; description: string | null }>) ?? []
  const industry = String(input.industry ?? '')

  const serviceLines = services.slice(0, 5).map((service) => service.name)

  return {
    executiveSummary:
      `${companyName} has reviewed what ${clientName} needs for ${title} and proposes a scope built around ` +
      `${serviceLines.length > 0 ? serviceLines.slice(0, 2).join(' and ') : 'the work discussed'}. ` +
      `The intent is a clear price, a firm sequence of work, and no surprises once it starts.`,
    scope:
      serviceLines.length > 0
        ? `The work covers:\n\n${serviceLines.map((line) => `• ${line}`).join('\n')}\n\nEach item is priced separately below so the scope can be adjusted without renegotiating the whole proposal.`
        : `The work covers ${title} end to end, priced by phase so it can be adjusted without renegotiating the whole proposal.`,
    exclusions:
      'Permits and municipal fees, utility connections, and any work uncovered once existing structures are opened up. Anything outside this scope is quoted separately before it starts.',
    followUpMessage:
      `Hello — we have put together the proposal for ${title}. It sets out the scope, the price, and what is not included. ` +
      `Happy to walk through it whenever suits.${industry ? ` We have done a fair amount of ${industry.toLowerCase()} work, so most questions have a ready answer.` : ''}`,
  }
}

function draftCampaign(input: Record<string, unknown>): unknown {
  const companyName = String(input.companyName ?? 'us')
  const segmentName = String(input.segmentName ?? 'this audience')
  const goal = String(input.goal ?? 'stay in touch')
  const audienceSize = Number(input.audienceSize ?? 0)

  return {
    subject: `A short note from ${companyName}`,
    previewText: 'Two minutes, and nothing to sign.',
    headline: `Still worth a conversation`,
    body:
      `We work with people in much the same position as you, and the questions that come up are usually the same three or four. ` +
      `If any of them are on your mind, a short call costs nothing and usually saves a fortnight of guessing.\n\n` +
      `No obligation either way — if the timing is wrong, say so and we will leave it.`,
    callToAction: 'Book a 20-minute call',
    rationale:
      `Written for ${segmentName}${audienceSize > 0 ? ` (${audienceSize} contactable)` : ''} with the goal of "${goal}". ` +
      `Kept short and low-pressure, because a first approach that asks for little gets read.`,
  }
}

function businessInsights(input: Record<string, unknown>): unknown {
  const insights: Array<Record<string, unknown>> = []

  const cashCents = Number(input.cashBalanceCents ?? 0)
  const receivableCents = Number(input.receivableCents ?? 0)
  const overdueCents = Number(input.overdueReceivableCents ?? 0)
  const payableCents = Number(input.payableCents ?? 0)
  const winRateBp = Number(input.winRateBp ?? 0)
  const concentrationBp = Number(input.revenueConcentrationBp ?? 0)
  const topCustomer = String(input.topCustomerName ?? '')

  if (overdueCents > 0) {
    insights.push({
      title: 'Money owed past its due date',
      detail: `${formatCentsPlain(overdueCents)} of the ${formatCentsPlain(receivableCents)} owed to you is already overdue. That is the fastest cash available without selling anything.`,
      severity: overdueCents > cashCents ? 'high' : 'medium',
      metric: 'receivables',
    })
  }

  if (payableCents > cashCents && cashCents > 0) {
    insights.push({
      title: 'Bills exceed the balance',
      detail: `You owe ${formatCentsPlain(payableCents)} against ${formatCentsPlain(cashCents)} in the bank. Collecting the overdue invoices first would close most of that gap.`,
      severity: 'high',
      metric: 'cash_flow',
    })
  }

  if (concentrationBp >= 4000 && topCustomer) {
    insights.push({
      title: 'Revenue leans on one client',
      detail: `${topCustomer} accounts for ${(concentrationBp / 100).toFixed(0)}% of invoiced revenue. Losing them would be felt immediately — worth knowing rather than discovering.`,
      severity: concentrationBp >= 6000 ? 'high' : 'medium',
      metric: 'concentration',
    })
  }

  if (winRateBp > 0 && winRateBp < 3000) {
    insights.push({
      title: 'Proposals are not converting',
      detail: `${(winRateBp / 100).toFixed(0)}% of proposals are won. The loss reasons on the sales dashboard will say whether that is price or timing.`,
      severity: 'medium',
      metric: 'sales',
    })
  }

  if (insights.length === 0) {
    insights.push({
      title: 'Nothing needs attention',
      detail:
        'Cash covers what is owed, receivables are current, and the pipeline is converting. Nothing here calls for a decision this week.',
      severity: 'low',
      metric: 'overall',
    })
  }

  return { insights }
}

/**
 * Plain money formatting. The lib helper is not importable from a pure module.
 *
 * The currency was hardcoded to a dollar sign until Phase 129 — a small
 * instance of the defect that phase found in the caller, and the reason the
 * assistant could state a euro figure as dollars without anything noticing.
 */
function formatCentsPlain(cents: number, currency = 'USD'): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
