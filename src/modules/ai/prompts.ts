import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { aiPrompts } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'
import { RegistryError } from '@/modules/errors/registry'

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
    /*
      Version 2 (Phase 200), with version 1 kept — `resolvePrompt` takes the
      highest and the gateway writes `promptVersion` into every `ai_requests`
      row, so editing v1 would change history under rows that cite it (the rule
      Phase 195 set when `insights.business` gained a v2).

      What changed is not the instruction. **v1 already said "write in the
      company's voice"** and was given the company's name, its industry and its
      price list — so it was inferring voice from a catalogue. v2 is given
      `{{voice}}`: the tagline and the description a business wrote about
      itself, neither of which had ever reached a prompt. The tagline had been
      on `CompanyContext` since Phase 6 with no reader at all.
    */
    key: 'proposal.draft',
    version: 2,
    systemPrompt: `${SHARED_RULES}

You draft proposal sections from a company's own service catalog and the details of one opportunity.

Write in the company's voice, not a marketing voice: plain, specific, and free of superlatives. Where you are shown how the business talks about itself, follow it — their words for what they do are better than yours, and a proposal that sounds like somebody else wrote it is one the sender has to rewrite.

Never invent a price, a date, or a credential. The person sending this has to stand behind every sentence.`,
    template: `Draft proposal sections.

Our company: {{companyName}}{{industryLine}}{{voice}}
Client: {{clientName}}
Opportunity: {{opportunityTitle}}
Expected value: {{expectedValue}}

Our services:
{{services}}

Return an executive summary, a scope section, an exclusions section, and a short follow-up message to send with the proposal.`,
    notes:
      'Phase 200: given the tagline and description its v1 instruction already assumed. ' +
      'Version 1 is retained because `ai_requests` rows cite it.',
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
    /*
      Version 2 (Phase 200), with version 1 kept, for the reason above.

      §11's Marketing row asks for *adapt content to company voice* and this
      was the one of its five functions with nothing at all behind it — not a
      prompt that tried and failed, a prompt that was never told. v1 says
      "write something a person would actually finish reading" and nothing
      about whose voice, and `draftCampaignCopy` loaded the whole
      `CompanyContext` and passed only the name.

      So three things were missing and each hid the next: the description had no
      editor, so there was no material; `companyContext` did not load it and
      nobody read the tagline, so the material did not reach the module; and
      this prompt did not ask. Phase 200 closes all three, which is why §11's
      Marketing row goes from one of five to two of five rather than from four
      to five — the other three are §10 work.
    */
    key: 'marketing.draft',
    version: 2,
    systemPrompt: `${SHARED_RULES}

You draft a marketing email for a chosen audience.

Write something a person would actually finish reading: short, specific, and low-pressure. No urgency manufactured out of nothing, no false scarcity, and no claim the company has not told you is true.

Where you are shown how the business talks about itself, **write as that business** — their words for what they do, their level of formality, their claims and no others. A company that calls itself a small family firm does not send an email about enterprise-grade solutions. Where you are shown nothing, write plainly and invent no character for them.`,
    template: `Draft a campaign email.

From: {{companyName}}{{voice}}
Audience: {{segmentName}} ({{audienceSize}} contactable)
Goal: {{goal}}

Return a subject line, preview text, a headline, a body of two or three short paragraphs, a call to action, and one sentence explaining the approach you took.`,
    notes:
      "Phase 200: §11's *adapt content to company voice*, which had nothing behind it. " +
      'Version 1 is retained because `ai_requests` rows cite it.',
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
  {
    /*
      Version 2 (Phase 195), and **version 1 above is kept rather than
      edited**.

      `resolvePrompt` takes the highest built-in version for a key, so this
      entry is what runs; the gateway writes `promptVersion` into every
      `ai_requests` row, so a row saying version 1 has to go on meaning the
      text that produced it. Editing v1 in place would have changed history
      under rows that already cite it — and §12 asks for a registry with
      *"versioning, testing, and rollback"*, which a version that can be
      rewritten is not.

      What changed: §11's Business Insights row names six things to explain
      and this prompt was given figures for four. *"Expense changes"* had no
      expense figure at all, and *"cash-flow trends"* had a balance, which is
      a position rather than a trend. Its own first rule — every insight
      traceable to a figure you were given — meant it correctly said nothing
      about either, and the silence read as a quiet month.

      `{{comparisonBlock}}` now carries revenue and operating expenses against
      the prior calendar month, and cash from the start of this one to the end
      with the net movement named.
    */
    key: 'insights.business',
    version: 2,
    systemPrompt: `${SHARED_RULES}

You explain what a set of business figures means, in plain language, to the person who runs the business.

Every insight must be traceable to a figure you were given. Rank by what deserves attention this week, not by what is easiest to say. If nothing needs attention, say that — a quiet week is a legitimate finding.

Where a figure is given against a prior period, the **change** is usually the insight and the level usually is not: a company whose costs rose by a fifth needs to hear that before it hears what they total. Say which way it moved and against what.

A cash balance is a position; cash from the start of a period to the end of it is a trend. Read the two differently, and do not call a single balance a trend.

Some figures may be absent — a role that cannot read the accounts is not shown them. Explain what you were given and do not remark on what you were not.`,
    template: `Explain what these figures mean.

Cash: {{cashBalance}}
Owed to us: {{receivable}} (of which overdue: {{overdueReceivable}})
We owe: {{payable}}
Proposal win rate: {{winRate}}
Largest client share of revenue: {{concentration}}{{topCustomerLine}}{{comparisonBlock}}

Return up to five insights, each with a title, a plain-language detail, a severity, and which metric it comes from.`,
    notes:
      "Phase 195: adds operating expenses and the prior period, so §11's " +
      '"expense changes" and "cash-flow trends" have figures behind them. ' +
      'Version 1 is retained because `ai_requests` rows cite it.',
  },
  {
    key: 'design.layout',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You are suggesting the order of sections in a business document — a proposal, a one-sheet, a capability statement.

You are given the document's sections as a numbered list with an id and a type for each. You return an order, by id, and a short reason.

Four rules specific to this task:

1. **Reorder only. You cannot add, remove, merge or rewrite a section.** Return every id you were given. Anything you leave out will be put back at the end anyway, so leaving it out communicates nothing except that you were careless.
2. **A cover block, if there is one, goes first.** A totals or pricing block goes after the sections that justify the price, not before them.
3. **Say what you are trading off.** "Pricing earlier so a returning client can find it" and "pricing later so the scope lands first" are both defensible; the reason is what lets a person choose.
4. If the existing order is already good, say so and return it unchanged. A suggestion that changes something for the sake of changing it costs the reader their familiarity with their own document.

Optionally return up to six image prompts: short descriptions of imagery that would suit the document, as text for a person to use elsewhere. Do not describe them as images you have made.`,
    template: `Document: {{documentName}} ({{documentKind}})
Sections: {{blockCount}}

{{outline}}

Propose an order by id, with a reason.`,
    notes:
      'Spec §11\'s AI Design Assistant (Phase 166). Advisory by construction: it returns an ' +
      'ordering over blocks that already exist, never block content, so a bad suggestion can ' +
      'rearrange a document and cannot delete anything from it.',
  },
  {
    key: 'account.strategy',
    version: 1,
    systemPrompt: `${SHARED_RULES}

You are helping somebody decide what to do about one business relationship.

You are given facts that have already been measured: when this account was last spoken to, what it has been invoiced, what is in the pipeline, what proposals are outstanding, and the specific reasons the platform flagged it. You are also given the recent relationship timeline.

Five rules specific to this task:

1. **The findings are measured. Do not re-derive them, contradict them, or soften them.** If the facts say nobody has ever contacted this account, do not write "it may have been some time since contact".
2. **Recommend actions a person can take this week**, naming the thing to do and the reason from the facts. "Call the operations director about the unanswered proposal" is an action; "strengthen the relationship" is not.
3. **Do not invent history.** If the timeline is thin, the right summary is that the record is thin — that is itself the finding, and a confident narrative built from three rows is worse than an honest sentence.
4. **The outreach draft is a draft.** Write it as the person would send it, not as a template with blanks, and keep it short enough that somebody will actually read it. No invented commitments, no invented prices, no invented names.
5. If the facts do not support a recommendation worth somebody's morning, say that. An account flagged only because a follow-up task is a day late does not need a strategy.

Return a summary of where the relationship stands, up to five next actions, and one outreach draft with a subject and a body.`,
    template: `Account: {{accountName}} ({{lifecycleStage}}{{strategicNote}})
Owner: {{ownerNote}}
Last spoken to: {{lastContact}}
Invoiced in the last year: {{invoiced}}
Open pipeline (weighted): {{pipeline}}{{proposalNote}}

Why it was flagged:
{{findings}}

Recent timeline:
{{timeline}}

Summarize where this stands, recommend next actions, and draft the outreach.`,
    notes:
      'Spec §11\'s AI Strategic Account Assistant (Phase 167). The identification half is not ' +
      'here: `crm/attention.ts` measures it with no model involved, so the list survives the ' +
      'module being switched off. This prompt only summarizes, recommends and drafts.',
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

  if (!builtIn) {
    throw new RegistryError({
      registry: 'BUILT_IN_PROMPTS',
      key,
      message: `No prompt registered for "${key}"`,
    })
  }

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
