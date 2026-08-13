import { z } from 'zod'

/**
 * The contract between the application and whatever model is answering
 * (spec §12: "Structured outputs (JSON schemas) for categorization
 * suggestions, campaign plans, proposal sections, and actions; validate
 * before use").
 *
 * Each capability declares its shape twice: once as a Zod schema, which the
 * gateway validates every response against, and once as JSON Schema, which is
 * sent to providers that can constrain generation. Keeping both here rather
 * than deriving one from the other is deliberate — the JSON Schema also
 * carries the field *descriptions* the model reads, which are prompt content,
 * not type information.
 */

// --- Bookkeeping: categorize ----------------------------------------------

export const categorizeSchema = z.object({
  /** Null when the model will not commit — never a guess. */
  chartAccountId: z.string().uuid().nullable(),
  confidenceBp: z.number().int().min(0).max(10_000),
  rationale: z.string().min(1).max(500),
})

export type CategorizeSuggestion = z.infer<typeof categorizeSchema>

export const categorizeJsonSchema = {
  type: 'object',
  properties: {
    chartAccountId: {
      type: ['string', 'null'],
      description: 'The id of the chosen account, exactly as given. Null if unsure.',
    },
    confidenceBp: {
      type: 'integer',
      description: 'Confidence from 0 to 10000 basis points. Use 0 with a null account.',
    },
    rationale: {
      type: 'string',
      description: 'One sentence, in plain language, saying why this account.',
    },
  },
  required: ['chartAccountId', 'confidenceBp', 'rationale'],
  additionalProperties: false,
}

// --- Bookkeeping: anomalies ------------------------------------------------

export const anomaliesSchema = z.object({
  findings: z
    .array(
      z.object({
        kind: z.enum(['duplicate', 'outlier', 'miscategorized', 'other']),
        transactionIds: z.array(z.string().uuid()).min(1),
        severity: z.enum(['low', 'medium', 'high']),
        explanation: z.string().min(1).max(400),
      }),
    )
    .max(25),
})

export type AnomalyFindings = z.infer<typeof anomaliesSchema>

export const anomaliesJsonSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: 'Only findings the data supports. An empty list is a valid answer.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['duplicate', 'outlier', 'miscategorized', 'other'] },
          transactionIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids exactly as given in the input.',
          },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          explanation: { type: 'string', description: 'One sentence the owner can act on.' },
        },
        required: ['kind', 'transactionIds', 'severity', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

// --- Bookkeeping: rule proposal -------------------------------------------

export const ruleSchema = z.object({
  name: z.string().min(1).max(80),
  // The same field and operator names the rules engine uses. A parallel
  // vocabulary here would need a translation table on the accept path, and
  // a translation table is where a mismatch hides.
  field: z.enum(['description', 'merchantName', 'amountCents', 'absAmountCents', 'direction']),
  operator: z.enum([
    'contains',
    'not_contains',
    'equals',
    'not_equals',
    'starts_with',
    'ends_with',
  ]),
  value: z.string().min(1).max(120),
  action: z.enum(['auto', 'suggest']),
  confidenceBp: z.number().int().min(0).max(10_000),
  rationale: z.string().min(1).max(400),
})

export type RuleSuggestion = z.infer<typeof ruleSchema>

export const ruleJsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A short name a person would recognize.' },
    field: {
      type: 'string',
      enum: ['description', 'merchantName', 'amountCents', 'absAmountCents', 'direction'],
    },
    operator: {
      type: 'string',
      enum: ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with'],
    },
    value: {
      type: 'string',
      description: 'The distinctive part of the merchant name, without store numbers.',
    },
    action: {
      type: 'string',
      enum: ['auto', 'suggest'],
      description: 'auto categorizes on arrival; suggest keeps the user in the loop.',
    },
    confidenceBp: { type: 'integer' },
    rationale: { type: 'string' },
  },
  required: ['name', 'field', 'operator', 'value', 'action', 'confidenceBp', 'rationale'],
  additionalProperties: false,
}

// --- Bookkeeping: summary --------------------------------------------------

export const summarySchema = z.object({
  summary: z.string().min(1).max(600),
  suggestedNextStep: z.string().min(1).max(300),
})

export type InboxSummary = z.infer<typeof summarySchema>

export const summaryJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two sentences at most.' },
    suggestedNextStep: { type: 'string', description: 'One concrete action.' },
  },
  required: ['summary', 'suggestedNextStep'],
  additionalProperties: false,
}

// --- Reconciliation --------------------------------------------------------

export const reconciliationSchema = z.object({
  explanation: z.string().min(1).max(400),
  likelyCauses: z.array(z.string().min(1).max(400)).max(6),
  suggestedTransactionIds: z.array(z.string().uuid()).max(10),
})

export type ReconciliationExplanation = z.infer<typeof reconciliationSchema>

export const reconciliationJsonSchema = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'One sentence stating the difference.' },
    likelyCauses: {
      type: 'array',
      items: { type: 'string' },
      description: 'Most likely first. Only causes the data supports.',
    },
    suggestedTransactionIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Transactions that would resolve the difference, if any.',
    },
  },
  required: ['explanation', 'likelyCauses', 'suggestedTransactionIds'],
  additionalProperties: false,
}

// --- Proposal drafting -----------------------------------------------------

export const proposalDraftSchema = z.object({
  executiveSummary: z.string().min(1).max(2000),
  scope: z.string().min(1).max(4000),
  exclusions: z.string().min(1).max(2000),
  followUpMessage: z.string().min(1).max(1500),
})

export type ProposalDraft = z.infer<typeof proposalDraftSchema>

export const proposalDraftJsonSchema = {
  type: 'object',
  properties: {
    executiveSummary: { type: 'string', description: 'Two or three sentences.' },
    scope: { type: 'string', description: 'What the work covers. No prices.' },
    exclusions: { type: 'string', description: 'What is explicitly not included.' },
    followUpMessage: { type: 'string', description: 'A short covering note.' },
  },
  required: ['executiveSummary', 'scope', 'exclusions', 'followUpMessage'],
  additionalProperties: false,
}

// --- Marketing drafting ----------------------------------------------------

export const campaignDraftSchema = z.object({
  subject: z.string().min(1).max(150),
  previewText: z.string().max(200),
  headline: z.string().min(1).max(150),
  body: z.string().min(1).max(3000),
  callToAction: z.string().min(1).max(80),
  rationale: z.string().max(400),
})

export type CampaignDraft = z.infer<typeof campaignDraftSchema>

export const campaignDraftJsonSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Under 60 characters reads best in an inbox.' },
    previewText: { type: 'string' },
    headline: { type: 'string' },
    body: { type: 'string', description: 'Two or three short paragraphs.' },
    callToAction: { type: 'string', description: 'A button label, a few words.' },
    rationale: { type: 'string', description: 'One sentence on the approach taken.' },
  },
  required: ['subject', 'previewText', 'headline', 'body', 'callToAction', 'rationale'],
  additionalProperties: false,
}

// --- Business insights -----------------------------------------------------

export const insightsSchema = z.object({
  insights: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        detail: z.string().min(1).max(600),
        severity: z.enum(['low', 'medium', 'high']),
        metric: z.string().min(1).max(60),
      }),
    )
    .max(5),
})

export type BusinessInsights = z.infer<typeof insightsSchema>

export const insightsJsonSchema = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      description: 'Up to five, ordered by what deserves attention first.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short headline.' },
          detail: {
            type: 'string',
            description: 'Plain language, naming the figures it is based on.',
          },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          metric: {
            type: 'string',
            description: 'Which area: cash_flow, receivables, sales, concentration, overall.',
          },
        },
        required: ['title', 'detail', 'severity', 'metric'],
        additionalProperties: false,
      },
    },
  },
  required: ['insights'],
  additionalProperties: false,
}
