import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { aiRequests, aiSuggestions, bankTransactions } from '@/db/schema'
import { addUserWithRole, createCompanyFixture, insertTransaction, type Fixture } from './helpers'
import { estimateCostMicros, formatMicros } from '@/modules/ai/provider'
import { getAiProvider, mockAiProvider, providerStatus } from '@/modules/ai/registry'
import { AnthropicProvider } from '@/modules/ai/anthropic-provider'
import { ask } from '@/modules/ai/gateway'
import {
  BUILT_IN_PROMPTS,
  activatePromptVersion,
  renderTemplate,
  resolvePrompt,
  savePromptVersion,
} from '@/modules/ai/prompts'
import {
  aiAvailable,
  checkGate,
  getSettings,
  providerHealth,
  updateSettings,
  usageWindow,
} from '@/modules/ai/settings'
import {
  acceptanceStats,
  pendingFor,
  recordSuggestion,
  rejectSuggestion,
} from '@/modules/ai/suggestions'
import {
  acceptCategorization,
  acceptRule,
  reviewAnomalies,
  suggestCategory,
  suggestRule,
  summarizeInbox,
} from '@/modules/ai/bookkeeping'
import { businessInsights } from '@/modules/ai/assistants'
import { accountOptions, inboxShape } from '@/modules/ai/retrieval'
import { categorizeSchema, categorizeJsonSchema } from '@/modules/ai/schemas'
import { listInbox } from '@/modules/bookkeeping/transactions'
import { listRules } from '@/modules/bookkeeping/rules-engine'
import { historyFor, recentActivity } from '@/modules/audit'

/**
 * Phase 6 — the optional AI module (spec §11, §12, §22, §23).
 *
 * The first describe block is the one that matters most: spec §23 requires AI
 * to be additive and never required, and §22 requires the core milestone to
 * work with no AI provider configured. Those are claims that can be tested,
 * so they are.
 */

/** A company with AI switched on and a few transactions to work with. */
async function aiFixture(): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name: 'AI Co', industry: 'construction' })
  await updateSettings(fixture.ctx, { enabled: true, provider: 'mock' })
  return fixture
}

// --- The guarantee: the core works without AI ------------------------------

describe('the core product does not depend on AI', () => {
  it('leaves every company with the module off', async () => {
    const fixture = await createCompanyFixture({ name: 'Fresh Co' })

    const settings = await getSettings(fixture.companyId)
    expect(settings.enabled).toBe(false)
    expect(await aiAvailable(fixture.ctx)).toBe(false)
  })

  it('runs the whole bookkeeping workflow with the module off', async () => {
    const fixture = await createCompanyFixture({ name: 'No AI Co', industry: 'construction' })
    const fuel = await fixture.account('6800')

    const transaction = await insertTransaction(fixture, {
      amountCents: -8_450,
      description: 'SHELL OIL 4471',
      merchantName: 'Shell',
    })

    // Categorize, list, and audit — the Phase 1 path, untouched.
    const { categorize } = await import('@/modules/bookkeeping/transactions')
    await categorize(fixture.ctx, transaction.id, fuel.id)

    const inbox = await listInbox(fixture.ctx, { states: ['categorized'] })
    expect(inbox.rows.some((row) => row.id === transaction.id)).toBe(true)

    const history = await historyFor(fixture.ctx, 'bank_transaction', transaction.id)
    expect(history.length).toBeGreaterThan(0)

    // And nothing was written to any AI table.
    const requests = await db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.companyId, fixture.companyId))
    expect(requests).toHaveLength(0)
  })

  it('refuses an AI call when the module is off, and says why', async () => {
    const fixture = await createCompanyFixture({ name: 'Off Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -5_000,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    const result = await suggestCategory(fixture.ctx, transaction.id)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('disabled')
  })

  it('records blocked calls in the ledger, so "nothing happened" is answerable', async () => {
    const fixture = await createCompanyFixture({ name: 'Off Co 2' })
    await suggestCategory(
      fixture.ctx,
      (
        await insertTransaction(fixture, { amountCents: -1_000, description: 'HOME DEPOT' })
      ).id,
    )

    const [row] = await db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.companyId, fixture.companyId))

    expect(row.outcome).toBe('blocked_disabled')
    expect(row.costMicros).toBe(0)
  })
})

// --- Cost arithmetic -------------------------------------------------------

describe('cost estimation', () => {
  const pricing = {
    inputPerMillionMicros: 5_000_000,
    outputPerMillionMicros: 25_000_000,
    cachedInputPerMillionMicros: 500_000,
  }

  it('computes exact integer micros for whole-dollar prices', () => {
    // 1000 input at $5/M = $0.005 = 5000 micros; 100 output at $25/M = 2500.
    expect(
      estimateCostMicros(
        { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 },
        pricing,
      ),
    ).toBe(7_500)
  })

  it('bills cached input at the cached rate, not twice', () => {
    // 1000 input of which 800 cached: 200 × 5 + 800 × 0.5 = 1000 + 400.
    expect(
      estimateCostMicros(
        { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 800 },
        pricing,
      ),
    ).toBe(1_400)
  })

  it('never returns a negative cost when cached exceeds input', () => {
    expect(
      estimateCostMicros(
        { inputTokens: 100, outputTokens: 0, cachedInputTokens: 500 },
        pricing,
      ),
    ).toBeGreaterThanOrEqual(0)
  })

  it('formats sub-cent amounts honestly', () => {
    expect(formatMicros(0)).toBe('$0.00')
    expect(formatMicros(500)).toBe('<$0.01')
    expect(formatMicros(1_500_000)).toBe('$1.50')
  })
})

// --- The gateway -----------------------------------------------------------

describe('the gateway', () => {
  beforeEach(() => {
    mockAiProvider().reset()
  })

  it('writes a ledger row on every path', async () => {
    const fixture = await aiFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -12_000,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    await suggestCategory(fixture.ctx, transaction.id)
    mockAiProvider().failOnce()
    await suggestCategory(fixture.ctx, transaction.id)

    const rows = await db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.companyId, fixture.companyId))

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.outcome).sort()).toEqual(['ok', 'provider_error'])
    // Both carry the prompt version that answered them.
    expect(rows.every((row) => row.promptKey === 'bookkeeping.categorize')).toBe(true)
  })

  it('rejects output that does not match the schema, and changes nothing', async () => {
    const fixture = await aiFixture()

    // A schema the mock's answer cannot satisfy.
    const result = await ask(fixture.ctx, {
      feature: 'bookkeeping_categorize',
      promptKey: 'bookkeeping.categorize',
      values: {},
      input: { description: 'HOME DEPOT', amountCents: -100, accounts: [] },
      schema: categorizeSchema.extend({
        somethingTheModelWillNotReturn: categorizeSchema.shape.rationale,
      }),
      jsonSchema: categorizeJsonSchema,
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('invalid_output')

    const [row] = await db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.companyId, fixture.companyId))
    expect(row.outcome).toBe('invalid_output')
  })

  it('refuses a person without the permission before reaching a provider', async () => {
    const fixture = await aiFixture()
    // `readonly` may view bookkeeping but holds no `ai:use`, so the request
    // dies at the gateway rather than at retrieval.
    const readonly = await addUserWithRole(fixture, 'readonly')
    const transaction = await insertTransaction(fixture, {
      amountCents: -1_000,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    await expect(suggestCategory(readonly, transaction.id)).rejects.toThrow(/permission/i)
    expect(mockAiProvider().calls).toHaveLength(0)
  })
})

// --- Quotas and ceilings ---------------------------------------------------

describe('quotas and cost ceilings', () => {
  beforeEach(() => {
    mockAiProvider().reset()
  })

  it('blocks once the month reaches the ceiling', async () => {
    const fixture = await aiFixture()
    // A ceiling of zero micros means "no ceiling"; one micro is a real one.
    await updateSettings(fixture.ctx, { monthlyCeilingMicros: 1 })

    // Spend something by hand — the mock is free, so the ledger needs a row
    // with a cost on it for the ceiling to have anything to compare against.
    await db.insert(aiRequests).values({
      companyId: fixture.companyId,
      feature: 'bookkeeping_summary',
      promptKey: 'bookkeeping.summary',
      promptVersion: 1,
      provider: 'mock',
      model: 'test',
      costMicros: 10,
      outcome: 'ok',
    })

    const gate = await checkGate(fixture.companyId, 'bookkeeping_summary')
    expect(gate.allowed).toBe(false)
    expect(gate.allowed === false && gate.reason).toBe('ceiling')
  })

  it('blocks on the hourly rate limit', async () => {
    const fixture = await aiFixture()
    await updateSettings(fixture.ctx, { hourlyRequestLimit: 1 })

    await db.insert(aiRequests).values({
      companyId: fixture.companyId,
      feature: 'bookkeeping_summary',
      promptKey: 'bookkeeping.summary',
      promptVersion: 1,
      provider: 'mock',
      model: 'test',
      outcome: 'ok',
    })

    const gate = await checkGate(fixture.companyId, 'bookkeeping_summary')
    expect(gate.allowed === false && gate.reason).toBe('rate_limit')
  })

  it('blocks a capability switched off individually', async () => {
    const fixture = await aiFixture()
    await updateSettings(fixture.ctx, { disabledFeatures: ['bookkeeping_categorize'] })

    expect((await checkGate(fixture.companyId, 'bookkeeping_categorize')).allowed).toBe(false)
    // The others keep working — feature-level metering, not an all-or-nothing switch.
    expect((await checkGate(fixture.companyId, 'bookkeeping_summary')).allowed).toBe(true)
  })

  it('counts spend and volume for the current period', async () => {
    const fixture = await aiFixture()
    await summarizeInbox(fixture.ctx)

    const usage = await usageWindow(fixture.companyId)
    expect(usage.monthRequests).toBe(1)
    expect(usage.hourRequests).toBe(1)
  })

  it('only an ai:manage role may change the settings', async () => {
    const fixture = await aiFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await expect(updateSettings(bookkeeper, { enabled: false })).rejects.toThrow(/permission/i)
  })
})

// --- Providers -------------------------------------------------------------

describe('the provider registry', () => {
  it('falls back to the mock when the selected provider has no credentials', async () => {
    const fixture = await aiFixture()
    await updateSettings(fixture.ctx, { provider: 'anthropic' })

    const health = await providerHealth(fixture.companyId)
    // No ANTHROPIC_API_KEY in the test environment.
    expect(health.selected).toBe('anthropic')
    expect(health.effective).toBe('mock')
    expect(health.fellBack).toBe(true)
  })

  it('reports which adapters could actually run', () => {
    const statuses = providerStatus()
    expect(statuses.find((entry) => entry.key === 'mock')?.configured).toBe(true)
  })

  it('throws on an unknown provider key rather than guessing', () => {
    expect(() => getAiProvider('not-a-provider')).toThrow(/Unknown AI provider/)
  })

  it('reports itself unconfigured rather than failing at call time', async () => {
    const provider = new AnthropicProvider()

    if (!provider.isConfigured()) {
      const result = await provider.complete({
        feature: 'bookkeeping_summary',
        system: 'x',
        prompt: 'y',
        input: {},
        schema: {},
      })

      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/ANTHROPIC_API_KEY/)
    }
  })
})

// --- The prompt registry ---------------------------------------------------

describe('the prompt registry', () => {
  it('fills placeholders and leaves no template syntax behind', () => {
    expect(renderTemplate('Hello {{name}}, you owe {{amount}}.', { name: 'Sam' })).toBe(
      'Hello Sam, you owe .',
    )
  })

  it('resolves the built-in when a company has written nothing', async () => {
    const fixture = await createCompanyFixture({ name: 'Prompt Co' })
    const prompt = await resolvePrompt(fixture.companyId, 'bookkeeping.categorize')

    expect(prompt.source).toBe('built-in')
    expect(prompt.systemPrompt).toContain('proposing, not deciding')
  })

  it('prefers a company version and records which one answered', async () => {
    const fixture = await aiFixture()

    const saved = await savePromptVersion(fixture.ctx, {
      key: 'bookkeeping.summary',
      systemPrompt: 'Ours.',
      template: 'Summarize {{uncategorizedCount}}.',
      notes: 'House style',
    })

    const resolved = await resolvePrompt(fixture.companyId, 'bookkeeping.summary')
    expect(resolved.source).toBe('company')
    expect(resolved.version).toBe(saved.version)

    await summarizeInbox(fixture.ctx)

    const [row] = await db
      .select()
      .from(aiRequests)
      .where(
        and(
          eq(aiRequests.companyId, fixture.companyId),
          eq(aiRequests.promptKey, 'bookkeeping.summary'),
        ),
      )
    expect(row.promptVersion).toBe(saved.version)
  })

  it('never overwrites a version, so a rollback has something to go back to', async () => {
    const fixture = await aiFixture()

    const first = await savePromptVersion(fixture.ctx, {
      key: 'bookkeeping.summary',
      systemPrompt: 'v1',
      template: 'one',
    })
    const second = await savePromptVersion(fixture.ctx, {
      key: 'bookkeeping.summary',
      systemPrompt: 'v2',
      template: 'two',
    })

    expect(second.version).toBeGreaterThan(first.version)
    expect((await resolvePrompt(fixture.companyId, 'bookkeeping.summary')).version).toBe(
      second.version,
    )

    await activatePromptVersion(fixture.ctx, 'bookkeeping.summary', first.version)
    expect((await resolvePrompt(fixture.companyId, 'bookkeeping.summary')).version).toBe(
      first.version,
    )
  })

  it('rolls back to the built-in', async () => {
    const fixture = await aiFixture()
    await savePromptVersion(fixture.ctx, {
      key: 'bookkeeping.summary',
      systemPrompt: 'mine',
      template: 'mine',
    })

    await activatePromptVersion(fixture.ctx, 'bookkeeping.summary', null)
    expect((await resolvePrompt(fixture.companyId, 'bookkeeping.summary')).source).toBe('built-in')
  })

  it('refuses a prompt key the application does not use', async () => {
    const fixture = await aiFixture()
    await expect(
      savePromptVersion(fixture.ctx, { key: 'made.up', systemPrompt: 'x', template: 'y' }),
    ).rejects.toThrow(/not a prompt/i)
  })

  it('ships a built-in for every capability the gateway can call', () => {
    const keys = new Set(BUILT_IN_PROMPTS.map((prompt) => prompt.key))
    for (const key of [
      'bookkeeping.categorize',
      'bookkeeping.anomalies',
      'bookkeeping.rule',
      'bookkeeping.summary',
      'reconciliation.explain',
      'proposal.draft',
      'marketing.draft',
      'insights.business',
    ]) {
      expect(keys.has(key)).toBe(true)
    }
  })
})

// --- Retrieval and permissions ---------------------------------------------

describe('retrieval respects the actor’s permissions', () => {
  it('gives a role without bookkeeping access nothing to reason about', async () => {
    const fixture = await aiFixture()
    await insertTransaction(fixture, { amountCents: -100, description: 'SOMETHING' })

    const sales = await addUserWithRole(fixture, 'sales')

    expect(await accountOptions(sales)).toHaveLength(0)
    expect((await inboxShape(sales)).uncategorizedCount).toBe(0)

    // The same reads, for someone who may do them, are not empty.
    expect((await accountOptions(fixture.ctx)).length).toBeGreaterThan(0)
  })

  it('does not let an assistant become a way around a permission', async () => {
    const fixture = await aiFixture()
    const marketer = await addUserWithRole(fixture, 'marketing')

    const result = await businessInsights(marketer)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('permission')
  })
})

// --- Human in the loop -----------------------------------------------------

describe('nothing takes effect without a person', () => {
  beforeEach(() => {
    mockAiProvider().reset()
  })

  it('suggests a category without touching the transaction', async () => {
    const fixture = await aiFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -29_785,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    const result = await suggestCategory(fixture.ctx, transaction.id)
    expect(result.ok).toBe(true)

    const [row] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transaction.id))

    // Still exactly where it was.
    expect(row.chartAccountId).toBeNull()
    expect(row.reviewState).toBe('new')

    const pending = await pendingFor(fixture.ctx, 'bookkeeping_categorize', transaction.id)
    expect(pending?.status).toBe('pending')
  })

  it('applies through the ordinary service, and audits the person', async () => {
    const fixture = await aiFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -29_785,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    const suggestion = await suggestCategory(fixture.ctx, transaction.id)
    if (!suggestion.ok) throw new Error('expected a suggestion')

    await acceptCategorization(fixture.ctx, suggestion.suggestionId)

    const [row] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transaction.id))
    expect(row.chartAccountId).toBe(suggestion.account.id)

    // The audit log carries the ordinary categorization event — the person
    // categorized it — plus the record that a machine proposed it.
    const history = await historyFor(fixture.ctx, 'bank_transaction', transaction.id)
    expect(history.some((event) => event.action === 'transaction.categorize')).toBe(true)
    expect(history.every((event) => event.userId === fixture.userId)).toBe(true)

    const activity = await recentActivity(fixture.ctx, 50)
    expect(activity.some((event) => event.action === 'ai_suggestion.accept')).toBe(true)
  })

  it('cannot accept the same suggestion twice', async () => {
    const fixture = await aiFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -1_200,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    const suggestion = await suggestCategory(fixture.ctx, transaction.id)
    if (!suggestion.ok) throw new Error('expected a suggestion')

    await acceptCategorization(fixture.ctx, suggestion.suggestionId)
    await expect(
      acceptCategorization(fixture.ctx, suggestion.suggestionId),
    ).rejects.toThrow(/no longer awaiting/i)
  })

  it('records a rejection rather than deleting it', async () => {
    const fixture = await aiFixture()
    const suggestion = await recordSuggestion(fixture.ctx, {
      feature: 'bookkeeping_categorize',
      entityType: 'bank_transaction',
      payload: { chartAccountId: 'x' },
    })

    await rejectSuggestion(fixture.ctx, suggestion.id, 'Wrong account')

    const [row] = await db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, suggestion.id))

    expect(row.status).toBe('rejected')
    expect(row.decisionNote).toBe('Wrong account')
    expect(row.decidedBy).toBe(fixture.userId)
  })

  it('supersedes an older pending suggestion for the same thing', async () => {
    const fixture = await aiFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -900,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    const first = await suggestCategory(fixture.ctx, transaction.id)
    const second = await suggestCategory(fixture.ctx, transaction.id)
    if (!first.ok || !second.ok) throw new Error('expected suggestions')

    const rows = await db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.entityId, transaction.id))

    // One pending, one superseded — a reviewer is never asked to choose
    // between two machines.
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1)
    expect(rows.filter((row) => row.status === 'superseded')).toHaveLength(1)
  })

  it('rates acceptance over decided, not over everything raised', async () => {
    const fixture = await aiFixture()

    const a = await recordSuggestion(fixture.ctx, {
      feature: 'bookkeeping_categorize',
      entityType: 'bank_transaction',
      payload: {},
    })
    await recordSuggestion(fixture.ctx, {
      feature: 'bookkeeping_categorize',
      entityType: 'bank_transaction',
      payload: {},
    })

    await rejectSuggestion(fixture.ctx, a.id)

    const stats = await acceptanceStats(fixture.ctx)
    expect(stats.pending).toBe(1)
    expect(stats.rejected).toBe(1)
    // 0 accepted of 1 decided — the pending one is not counted against it.
    expect(stats.acceptanceRateBp).toBe(0)
  })
})

// --- Capability behaviour --------------------------------------------------

describe('the bookkeeping assistant', () => {
  beforeEach(() => {
    mockAiProvider().reset()
  })

  it('declines rather than guessing on an unrecognizable transaction', async () => {
    const fixture = await aiFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'POS 88213 XFER',
    })

    const result = await suggestCategory(fixture.ctx, transaction.id)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('declined')

    // Declining is not a failure — the call still succeeded and was metered.
    const [row] = await db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.companyId, fixture.companyId))
    expect(row.outcome).toBe('ok')

    // And nothing was queued for a person to review.
    const pending = await pendingFor(fixture.ctx, 'bookkeeping_categorize', transaction.id)
    expect(pending).toBeNull()
  })

  it('will not accept an account that is not this company’s', async () => {
    // The guard that stops a returned uuid becoming a journal line. Proven by
    // pointing the accepted suggestion at another company's account.
    const fixture = await aiFixture()
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const foreignAccount = await other.account('6800')

    const transaction = await insertTransaction(fixture, {
      amountCents: -1_000,
      description: 'HOME DEPOT #6612',
      merchantName: 'Home Depot',
    })

    const suggestion = await recordSuggestion(fixture.ctx, {
      feature: 'bookkeeping_categorize',
      entityType: 'bank_transaction',
      entityId: transaction.id,
      payload: { chartAccountId: foreignAccount.id },
    })

    await expect(
      acceptCategorization(fixture.ctx, suggestion.id),
    ).rejects.toThrow()
  })

  it('finds a duplicate charge', async () => {
    const fixture = await aiFixture()

    for (const date of ['2026-08-01', '2026-08-02']) {
      await insertTransaction(fixture, {
        amountCents: -12_500,
        description: 'ACME TOOLS',
        merchantName: 'Acme Tools',
        postedDate: date,
      })
    }
    await insertTransaction(fixture, {
      amountCents: -400,
      description: 'COFFEE',
      postedDate: '2026-08-03',
    })

    const result = await reviewAnomalies(fixture.ctx)
    if (!result.ok) throw new Error(result.message)

    const duplicate = result.findings.find((finding) => finding.kind === 'duplicate')
    expect(duplicate).toBeDefined()
    expect(duplicate!.transactions).toHaveLength(2)
  })

  it('refuses to propose a rule from a single categorization', async () => {
    const fixture = await aiFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -5_000,
      description: 'ACME TOOLS',
      merchantName: 'Acme Tools',
    })

    const result = await suggestRule(fixture.ctx, transaction.id)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('no_pattern')
  })

  it('proposes a rule from a pattern, and creating it goes through the rules service', async () => {
    const fixture = await aiFixture()
    const materials = await fixture.account('5110')
    const { categorize } = await import('@/modules/bookkeeping/transactions')

    const transactions = []
    for (let i = 0; i < 3; i++) {
      const row = await insertTransaction(fixture, {
        amountCents: -5_000 - i,
        description: 'ACME TOOLS SUPPLY',
        merchantName: 'Acme Tools',
      })
      await categorize(fixture.ctx, row.id, materials.id)
      transactions.push(row)
    }

    const result = await suggestRule(fixture.ctx, transactions[0].id)
    if (!result.ok) throw new Error(result.message)

    expect(result.rule.value.toLowerCase()).toContain('acme')
    // Four or more occurrences earns `auto`; three should still be `suggest`.
    expect(result.rule.action).toBe('suggest')

    await acceptRule(fixture.ctx, result.suggestionId)

    const rules = await listRules(fixture.ctx)
    expect(rules.some((rule) => rule.name === result.rule.name)).toBe(true)
  })

  it('summarizes an empty inbox without pretending there is work', async () => {
    const fixture = await aiFixture()
    const result = await summarizeInbox(fixture.ctx)

    expect(result.ok).toBe(true)
    expect(result.ok === true && result.summary).toMatch(/clear|nothing/i)
  })
})

describe('business insights', () => {
  beforeEach(() => {
    mockAiProvider().reset()
  })

  it('says nothing needs attention rather than inventing a problem', async () => {
    const fixture = await aiFixture()
    const result = await businessInsights(fixture.ctx)

    if (!result.ok) throw new Error(result.message)
    expect(result.insights.length).toBeGreaterThan(0)
    expect(result.insights[0].severity).toBe('low')
  })
})

// --- Tenancy ---------------------------------------------------------------

describe('tenant isolation', () => {
  beforeEach(() => {
    mockAiProvider().reset()
  })

  it('keeps one company’s usage and suggestions out of another’s', async () => {
    const a = await aiFixture()
    const b = await aiFixture()

    await summarizeInbox(a.ctx)

    expect((await usageWindow(b.companyId)).monthRequests).toBe(0)
    expect((await acceptanceStats(b.ctx)).total).toBe(0)
  })

  it('does not let one company read another’s prompt versions', async () => {
    const a = await aiFixture()
    const b = await aiFixture()

    await savePromptVersion(a.ctx, {
      key: 'bookkeeping.summary',
      systemPrompt: 'A only',
      template: 'A only',
    })

    const resolved = await resolvePrompt(b.companyId, 'bookkeeping.summary')
    expect(resolved.source).toBe('built-in')
  })

  it('settings are per company', async () => {
    const a = await aiFixture()
    const b = await createCompanyFixture({ name: 'Still Off Co' })

    expect((await getSettings(a.companyId)).enabled).toBe(true)
    expect((await getSettings(b.companyId)).enabled).toBe(false)
  })
})
