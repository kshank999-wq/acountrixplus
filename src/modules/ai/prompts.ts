import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { aiPrompts } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'

/**
 * The prompt registry (spec §12: "Central prompt/template registry with
 * versioning, testing, and rollback").
 *
 * Prompts are the part of an AI feature most likely to change, and the part
 * whose change is hardest to attribute after the fact. So they are data with
 * versions rather than string literals inside services, every request records
 * the key and version it used, and rolling back is activating an earlier
 * version rather than editing text in place.
 *
 * Built-ins live here in code — they ship with the application and are
 * installed on first use. A company may write its own version of any prompt;
 * a company version always wins over the built-in of the same key.
 */

export type PromptDefinition = {
  key: string
  version: number
  systemPrompt: string
  template: string
  notes: string
}

/**
 * A rule that appears in every system prompt.
 *
 * Stated once, here, rather than repeated per prompt — and worth stating at
 * all because it is the boundary the whole module rests on: the model
 * proposes, a person disposes.
 */
const SHARED_RULES = `
You are assisting inside an accounting and business platform. Three rules hold for every task:

1. You are proposing, not deciding. Everything you return is reviewed by a person before it takes effect. Never write as though an action has already happened.
2. Say when you do not know. A low-confidence answer that admits it is far more useful than a confident wrong one, because the person reviewing has to decide whether to trust you.
3. Use only the data given to you in the request. Do not infer figures that were not provided, and do not invent account names, client names, or amounts.

Respond only with JSON matching the requested schema.`.trim()

export const BUILT_IN_PROMPTS: PromptDefinition[] = [
  {
    key: 'bookkeeping.categorize',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You suggest which account a bank transaction belongs to. You are given the transaction and the company's own chart of accounts — choose only from those accounts, by id.

A transaction you cannot place confidently should return a null account rather than a guess. Categorizing wrongly is worse than not categorizing: it lands in the ledger and has to be found and undone.`,
    template: `Suggest an account for this transaction.

Date: {{postedDate}}
Description: {{description}}
Merchant: {{merchantName}}
Amount: {{amount}}

Accounts available:
{{accounts}}

Return the account id, a confidence in basis points (0-10000), and one sentence explaining the choice in plain language the business owner will understand.`,
    notes: 'Initial version. Refuses rather than guesses on unclear descriptions.',
  },
  {
    key: 'bookkeeping.anomalies',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You review recent bank activity for likely duplicates and unusual amounts. Report only what the data supports, and explain each finding in one sentence a business owner can act on.

Report nothing rather than padding the list. A review that flags five real things is worth more than one that flags fifty maybes.`,
    template: `Review these transactions for duplicates and unusual amounts.

{{transactions}}

For each finding give the kind (duplicate or outlier), the transaction ids involved, a severity, and a one-sentence explanation.`,
    notes: 'Initial version.',
  },
  {
    key: 'bookkeeping.rule',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You propose a categorization rule from a pattern the user has already established by hand.

The value you match on should be the distinctive part of the merchant name — not the store number, location, or card-network noise around it. A rule that matches too broadly quietly miscategorizes everything it touches.`,
    template: `The user has categorized {{occurrences}} transactions from this merchant into {{accountName}}.

Merchant: {{merchantName}}
Description: {{description}}

Propose a rule: a name, the field to match, the operator, the value, and whether it should categorize automatically or only suggest.`,
    notes: 'Initial version. Prefers suggest over auto below four occurrences.',
  },
  {
    key: 'bookkeeping.summary',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You summarize uncategorized activity for a business owner who has two minutes. Lead with the figure that matters, then name the single most useful next step.`,
    template: `Summarize the state of this transaction inbox.

Uncategorized: {{uncategorizedCount}} transactions, {{uncategorizedTotal}}
Most frequent merchants: {{topMerchants}}

Give a two-sentence summary and one suggested next step.`,
    notes: 'Initial version.',
  },
  {
    key: 'reconciliation.explain',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You explain why a bank reconciliation does not balance. You are given the difference and the transactions that have not been cleared.

Name the causes the data actually supports, most likely first. If an uncleared transaction matches the difference exactly, say so — that is almost always the answer.`,
    template: `This reconciliation is out of balance.

Difference: {{difference}}
Uncleared transactions: {{unclearedCount}}

{{candidates}}

Explain the difference, list the likely causes in order, and name any transactions that would resolve it.`,
    notes: 'Initial version.',
  },
  {
    key: 'proposal.draft',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You draft proposal sections from a company's own service catalog and the details of one opportunity.

Write in the company's voice, not a marketing voice: plain, specific, and free of superlatives. Never invent a price, a date, or a credential. The person sending this has to stand behind every sentence.`,
    template: `Draft proposal sections.

Our company: {{companyName}}{{industryLine}}
Client: {{clientName}}
Opportunity: {{opportunityTitle}}
Expected value: {{expectedValue}}

Our services:
{{services}}

Return an executive summary, a scope section, an exclusions section, and a short follow-up message to send with the proposal.`,
    notes: 'Initial version. Explicitly forbidden from inventing prices.',
  },
  {
    key: 'marketing.draft',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You draft a marketing email for a chosen audience.

Write something a person would actually finish reading: short, specific, and low-pressure. No urgency manufactured out of nothing, no false scarcity, and no claim the company has not told you is true.`,
    template: `Draft a campaign email.

From: {{companyName}}
Audience: {{segmentName}} ({{audienceSize}} contactable)
Goal: {{goal}}

Return a subject line, preview text, a headline, a body of two or three short paragraphs, a call to action, and one sentence explaining the approach you took.`,
    notes: 'Initial version.',
  },
  {
    key: 'insights.business',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You explain what a set of business figures means, in plain language, to the person who runs the business.

Every insight must be traceable to a figure you were given. Rank by what deserves attention this week, not by what is easiest to say. If nothing needs attention, say that — a quiet week is a legitimate finding.`,
    template: `Explain what these figures mean.

Cash: {{cashBalance}}
Owed to us: {{receivable}} (of which overdue: {{overdueReceivable}})
We owe: {{payable}}
Proposal win rate: {{winRate}}
Largest client share of revenue: {{concentration}}{{topCustomerLine}}

Return up to five insights, each with a title, a plain-language detail, a severity, and which metric it comes from.`,
    notes: 'Initial version.',
  },
]

/**
 * Fills `{{placeholders}}`.
 *
 * A placeholder with no value renders empty rather than leaving the raw
 * `{{name}}` in the prompt — the same choice the document engine makes, and
 * for the same reason: visible template syntax is the worse failure.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '')
}

export type ResolvedPrompt = {
  key: string
  version: number
  systemPrompt: string
  template: string
  source: 'built-in' | 'company'
}

/**
 * The prompt a call should use.
 *
 * A company's active version wins; otherwise the highest built-in version.
 * Nothing here writes to the database — installing built-ins is a separate,
 * explicit step so a read path never has a side effect.
 */
export async function resolvePrompt(
  companyId: string,
  key: string,
): Promise<ResolvedPrompt> {
  const [companyVersion] = await db
    .select()
    .from(aiPrompts)
    .where(
      and(eq(aiPrompts.companyId, companyId), eq(aiPrompts.key, key), eq(aiPrompts.isActive, true)),
    )
    .orderBy(desc(aiPrompts.version))
    .limit(1)

  if (companyVersion) {
    return {
      key,
      version: companyVersion.version,
      systemPrompt: companyVersion.systemPrompt,
      template: companyVersion.template,
      source: 'company',
    }
  }

  const builtIn = BUILT_IN_PROMPTS.filter((prompt) => prompt.key === key).sort(
    (a, b) => b.version - a.version,
  )[0]

  if (!builtIn) throw new Error(`No prompt registered for "${key}"`)

  return {
    key,
    version: builtIn.version,
    systemPrompt: builtIn.systemPrompt,
    template: builtIn.template,
    source: 'built-in',
  }
}

/** Every version of every prompt a company could choose between. */
export async function listPrompts(ctx: ActorContext) {
  requirePermission(ctx, 'ai:manage')

  const companyVersions = await db
    .select()
    .from(aiPrompts)
    .where(
      scoped(
        ctx,
        aiPrompts,
        or(eq(aiPrompts.companyId, ctx.companyId), isNull(aiPrompts.companyId)),
      ),
    )
    .orderBy(aiPrompts.key, desc(aiPrompts.version))

  return BUILT_IN_PROMPTS.map((builtIn) => {
    const overrides = companyVersions.filter((row) => row.key === builtIn.key)
    const active = overrides.find((row) => row.isActive)

    return {
      key: builtIn.key,
      builtIn,
      versions: overrides.map((row) => ({
        id: row.id,
        version: row.version,
        notes: row.notes,
        isActive: row.isActive,
        createdAt: row.createdAt,
      })),
      activeVersion: active?.version ?? builtIn.version,
      activeSource: active ? ('company' as const) : ('built-in' as const),
    }
  })
}

/**
 * Saves a company's own version of a prompt.
 *
 * Never edits an existing version. A new version is appended and activated,
 * so the one it replaced is still there to roll back to — the same rule the
 * clause library follows, and for the same reason: you cannot compare against
 * a version you overwrote.
 */
export async function savePromptVersion(
  ctx: ActorContext,
  input: { key: string; systemPrompt: string; template: string; notes?: string },
) {
  requirePermission(ctx, 'ai:manage')

  if (!BUILT_IN_PROMPTS.some((prompt) => prompt.key === input.key)) {
    throw new Refusal(`"${input.key}" is not a prompt this application uses.`)
  }
  if (!input.template.trim()) {
    throw new Refusal('A prompt needs a template.')
  }

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ version: aiPrompts.version })
      .from(aiPrompts)
      .where(and(eq(aiPrompts.companyId, ctx.companyId), eq(aiPrompts.key, input.key)))
      .orderBy(desc(aiPrompts.version))
      .limit(1)

    // Company versions start above the built-in, so a version number is
    // unambiguous in the usage ledger without also storing the source.
    const builtInMax = Math.max(
      ...BUILT_IN_PROMPTS.filter((prompt) => prompt.key === input.key).map((p) => p.version),
    )
    const version = Math.max(latest?.version ?? 0, builtInMax) + 1

    await tx
      .update(aiPrompts)
      .set({ isActive: false })
      .where(and(eq(aiPrompts.companyId, ctx.companyId), eq(aiPrompts.key, input.key)))

    const [saved] = await tx
      .insert(aiPrompts)
      .values({
        companyId: ctx.companyId,
        key: input.key,
        version,
        systemPrompt: input.systemPrompt,
        template: input.template,
        notes: input.notes ?? null,
        isActive: true,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'ai_prompt.save',
        entityType: 'ai_prompt',
        entityId: saved.id,
        after: { key: input.key, version },
      },
      tx,
    )

    return saved
  })
}

/**
 * Rolls back to an earlier version (spec §12).
 *
 * Passing null activates the built-in — the way back out of a customization
 * that made things worse.
 */
export async function activatePromptVersion(
  ctx: ActorContext,
  key: string,
  version: number | null,
) {
  requirePermission(ctx, 'ai:manage')

  return db.transaction(async (tx) => {
    await tx
      .update(aiPrompts)
      .set({ isActive: false })
      .where(and(eq(aiPrompts.companyId, ctx.companyId), eq(aiPrompts.key, key)))

    if (version !== null) {
      const [activated] = await tx
        .update(aiPrompts)
        .set({ isActive: true })
        .where(
          and(
            eq(aiPrompts.companyId, ctx.companyId),
            eq(aiPrompts.key, key),
            eq(aiPrompts.version, version),
          ),
        )
        .returning({ id: aiPrompts.id })

      if (!activated) throw new Refusal(`Version ${version} of "${key}" was not found.`)
    }

    await recordAudit(
      ctx,
      {
        action: 'ai_prompt.activate',
        entityType: 'ai_prompt',
        entityId: null,
        after: { key, version: version ?? 'built-in' },
      },
      tx,
    )
  })
}
