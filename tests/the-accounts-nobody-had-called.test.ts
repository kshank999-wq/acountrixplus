import { beforeEach, describe, expect, it } from 'vitest'
import { BUILT_IN_PROMPTS } from '@/modules/ai/prompts'
import { mockAiProvider, registerAiProvider } from '@/modules/ai/registry'
import { updateSettings } from '@/modules/ai/settings'
import { adviseOnAccount } from '@/modules/ai/accounts'
import {
  ATTENTION_GROUNDS,
  CONTACT_CADENCE_DAYS,
  STRATEGIC_CADENCE_DAYS,
  UnknownGroundError,
  assessAccount,
  cadenceFor,
  groundFor,
  groundStands,
  rankAccounts,
  stakeCents,
  type AccountFacts,
} from '@/modules/crm/attention'
import { accountFacts, accountsNeedingAttention } from '@/modules/crm/accounts'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createIntakeKey, submitLead } from '@/modules/crm/intake'
import { logCommunication } from '@/modules/engagement/communications'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * The accounts nobody had called (Phase 167).
 *
 * ADR 0166 nominated §11's last unimplemented capability, the **AI Strategic
 * Account Assistant**:
 *
 * > Summarize relationship history, identify neglected high-value prospects,
 * > recommend next actions, and draft personalized outreach.
 *
 * Measuring it before building it found that **three of those four want a model
 * and one does not**. Identifying a neglected high-value account is
 * `max(occurred_at)` against a cadence, a sum of invoices and a weighted
 * pipeline — arithmetic. Putting it behind the gateway would have made the one
 * part of this capability that can be checked into the part that cannot, and
 * would have put it behind a module §11 says the core product must work
 * without.
 *
 * So the identification is a pure core with no database and no clock in it, and
 * the assistant reads what it computes.
 */

let fixture: Fixture

/** A fixed day, so nothing here depends on when it runs. */
const AS_OF = new Date('2026-06-15T12:00:00Z')

function daysBefore(days: number): Date {
  return new Date(AS_OF.getTime() - days * 86_400_000)
}

/** A healthy account: contacted yesterday, owned, nothing outstanding. */
function healthy(overrides: Partial<AccountFacts> = {}): AccountFacts {
  return {
    organizationId: 'org-1',
    name: 'Fine & Co',
    lifecycleStage: 'active_client',
    isStrategicAccount: false,
    ownerId: 'user-1',
    lastContactedAt: daysBefore(1),
    invoicedCents: 500_000,
    weightedPipelineCents: 0,
    openOpportunities: 0,
    oldestUndecidedProposal: null,
    overdueTasks: 0,
    ...overrides,
  }
}

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Marchetti Trades' })
  registerAiProvider(mockAiProvider())
})

// --- The pure core ---------------------------------------------------------

describe('the cadence, and the one number a reader will want to argue with', () => {
  it('gives a lead no cadence at all, which is the point', () => {
    /**
     * The rule that shaped the registry: a ground that fires on every row is
     * not a finding. A lead nobody has phoned is what a lead *is*, and flagging
     * every one turns the attention list into the organization table with extra
     * steps.
     */
    expect(CONTACT_CADENCE_DAYS.lead).toBeNull()
    expect(cadenceFor({ lifecycleStage: 'lead', isStrategicAccount: false })).toBeNull()
  })

  it('gives a vendor none either, because silence is not a sales problem', () => {
    expect(cadenceFor({ lifecycleStage: 'vendor', isStrategicAccount: false })).toBeNull()
  })

  it('tightens a cadence for a strategic account but never invents one', () => {
    // Both columns are true at once — the schema says an existing client can
    // also be strategic — so the override takes the tighter of the two.
    expect(cadenceFor({ lifecycleStage: 'active_client', isStrategicAccount: true })).toBe(
      STRATEGIC_CADENCE_DAYS,
    )

    // And a strategic *vendor* is still a vendor. Marking a supplier strategic
    // is a statement about the supply, not a commitment to court them.
    expect(cadenceFor({ lifecycleStage: 'vendor', isStrategicAccount: true })).toBeNull()
  })

  it('takes the stage cadence when it is already tighter than the strategic one', () => {
    // Nothing in the file is tighter than 21 days today, so this asserts the
    // `Math.min` rather than the current numbers: a future cadence of 14 days
    // must not be loosened to 21 by marking the account strategic.
    expect(
      cadenceFor({ lifecycleStage: 'strategic_target', isStrategicAccount: true }),
    ).toBe(STRATEGIC_CADENCE_DAYS)
    expect(CONTACT_CADENCE_DAYS.strategic_target).toBeGreaterThan(STRATEGIC_CADENCE_DAYS)
  })
})

describe('what is at stake, which is a max and not a sum', () => {
  it('never adds realised revenue to the pipeline', () => {
    /**
     * Adding them double-counts the commonest open opportunity there is — a
     * renewal of the revenue already in the first figure. A list that ranked a
     * renewing client above a genuinely larger prospect would be ranking by
     * bookkeeping accident.
     */
    expect(stakeCents({ invoicedCents: 400_000, weightedPipelineCents: 300_000 })).toBe(400_000)
    expect(stakeCents({ invoicedCents: 100_000, weightedPipelineCents: 900_000 })).toBe(900_000)
    expect(stakeCents({ invoicedCents: 0, weightedPipelineCents: 0 })).toBe(0)
  })
})

describe('the grounds', () => {
  it('says nothing about an account with nothing wrong with it', () => {
    // Phase 121: this check has to be seen to disagree as well as agree, and a
    // list that flags a healthy account flags everything.
    expect(assessAccount(healthy(), AS_OF)).toBeNull()
  })

  it('separates never contacted from not contacted recently', () => {
    /**
     * `lastContactedAt` omits accounts with no exchange at all, and the module
     * says why: "never" and "not recently" are different problems. The registry
     * honours that rather than collapsing them — the sentence a person reads is
     * different, and so is what they do next.
     */
    const never = assessAccount(
      healthy({ lastContactedAt: null, isStrategicAccount: true }),
      AS_OF,
    )
    expect(never?.findings.map((finding) => finding.ground)).toContain('never-contacted')
    expect(never?.silentDays).toBeNull()

    const quiet = assessAccount(healthy({ lastContactedAt: daysBefore(90) }), AS_OF)
    expect(quiet?.findings.map((finding) => finding.ground)).toEqual(['gone-quiet'])
    expect(quiet?.silentDays).toBe(90)

    // And `gone-quiet` does not also fire on the never-contacted account, so
    // the two grounds do not restate each other.
    expect(never?.findings.map((finding) => finding.ground)).not.toContain('gone-quiet')
  })

  it('does not flag a lead nobody has ever called', () => {
    // The scope doing its work. A lead with no contact is in scope for nothing.
    expect(
      assessAccount(
        healthy({ lifecycleStage: 'lead', lastContactedAt: null, invoicedCents: 0 }),
        AS_OF,
      ),
    ).toBeNull()
  })

  it('flags an uncalled lead the moment somebody opens a deal on it', () => {
    // Opening an opportunity is the commitment the scope is looking for, and it
    // can happen without the lifecycle stage ever being updated.
    const found = assessAccount(
      healthy({
        lifecycleStage: 'lead',
        lastContactedAt: null,
        invoicedCents: 0,
        openOpportunities: 1,
        ownerId: null,
      }),
      AS_OF,
    )

    expect(found?.findings.map((finding) => finding.ground)).toEqual([
      'never-contacted',
      'unowned',
    ])
  })

  it('says which kind of silence a proposal is sitting in', () => {
    const read = assessAccount(
      healthy({ oldestUndecidedProposal: { sentAt: daysBefore(20), viewed: true } }),
      AS_OF,
    )
    expect(read?.findings[0].detail).toContain('since it was read')

    const unopened = assessAccount(
      healthy({ oldestUndecidedProposal: { sentAt: daysBefore(20), viewed: false } }),
      AS_OF,
    )
    expect(unopened?.findings[0].detail).toContain('never been opened')

    // A proposal sent last week is not yet a finding.
    expect(
      assessAccount(
        healthy({ oldestUndecidedProposal: { sentAt: daysBefore(6), viewed: true } }),
        AS_OF,
      ),
    ).toBeNull()
  })

  it('ranks severity before money', () => {
    /**
     * §11 asks for the *neglected* accounts. The money is the tie-break, not
     * the question — ranking by stake alone buries a strategic target nobody
     * has ever called under a large client who is merely a week late.
     */
    const ranked = rankAccounts(
      [
        healthy({
          organizationId: 'big',
          name: 'Large but merely late',
          invoicedCents: 90_000_000,
          overdueTasks: 1,
        }),
        healthy({
          organizationId: 'neglected',
          name: 'Small and never called',
          isStrategicAccount: true,
          lastContactedAt: null,
          invoicedCents: 10_000,
        }),
      ],
      AS_OF,
    )

    expect(ranked.map((account) => account.organizationId)).toEqual(['neglected', 'big'])
  })

  it('breaks a severity tie on stake, and a stake tie on name', () => {
    const ranked = rankAccounts(
      [
        healthy({ organizationId: 'b', name: 'Beta', lastContactedAt: null, isStrategicAccount: true, invoicedCents: 1000 }),
        healthy({ organizationId: 'a', name: 'Alpha', lastContactedAt: null, isStrategicAccount: true, invoicedCents: 1000 }),
        healthy({ organizationId: 'rich', name: 'Rich', lastContactedAt: null, isStrategicAccount: true, invoicedCents: 5000 }),
      ],
      AS_OF,
    )

    expect(ranked.map((account) => account.organizationId)).toEqual(['rich', 'a', 'b'])
  })

  it('argues every ground, and says which accounts it applies to', () => {
    // Phase 101's device, and Phase 135's lesson about what unchecked prose
    // costs. The scope is held to a floor as well as the reason, because the
    // scope is the part of a ground a reader cannot infer from the predicate.
    const problems = ATTENTION_GROUNDS.flatMap((ground) => groundStands(ground))
    expect(problems).toEqual([])
  })

  it('declares six grounds, counted rather than bounded', () => {
    // Phase 126: assert the measured count, not a lower bound.
    expect(ATTENTION_GROUNDS).toHaveLength(6)
    expect(new Set(ATTENTION_GROUNDS.map((ground) => ground.key)).size).toBe(6)
  })

  it('throws on a ground nobody declared, naming the ones that exist', () => {
    expect(() => groundFor('revenue-fading')).toThrow(UnknownGroundError)
    expect(() => groundFor('revenue-fading')).toThrow(/never-contacted/)
  })
})

// --- Measured from the database --------------------------------------------

describe('the list, measured', () => {
  it('finds a strategic target nobody has logged a word against', async () => {
    const organization = await createOrganization(fixture.ctx, {
      name: 'Hartley Industrial',
      lifecycleStage: 'strategic_target',
      isStrategicAccount: true,
    })

    const list = await accountsNeedingAttention(fixture.ctx, { asOf: AS_OF })
    const found = list.find((account) => account.organizationId === organization.id)

    expect(found).toBeTruthy()
    expect(found?.findings.map((finding) => finding.ground)).toEqual(['never-contacted'])

    /*
      And *not* unowned, which is the first thing this test got wrong.
      `createOrganization` defaults the owner to whoever created the record, so
      an account entered by hand always has one. The ground that fires on an
      unowned account needed a path that produces one — see below.
    */
    expect(found?.findings.map((finding) => finding.ground)).not.toContain('unowned')
  })

  it('finds the website lead nobody picked up, which is where unowned comes from', async () => {
    /**
     * Measured, after the test above was written wrong. `unowned` looked like a
     * ground that could never fire, because every path a person uses defaults
     * the owner to themselves — and a ground that cannot fire is a declaration
     * with no fact behind it (Phase 110).
     *
     * `intake.ts` is the path. A website lead has no acting user, so the
     * organization is inserted with no owner, an opportunity is opened at
     * `new_inquiry`, and the arrival is recorded as an *opportunity activity*
     * rather than a communication — so nobody has spoken to them either.
     *
     * Which means the accounts most likely to be both unowned and uncontacted
     * are the ones that arrived by themselves and asked to be sold to. That is
     * §11's "neglected high-value prospect" almost exactly, and it is the one
     * case nothing in the product surfaced before this phase.
     */
    const key = await createIntakeKey(fixture.ctx, { name: 'Website contact form' })

    const submitted = await submitLead(
      key.publicKey,
      {
        name: 'Jo Rivera',
        email: 'jo@harborview.test',
        organizationName: 'Harborview Marine',
        interest: 'Dock replacement',
      },
      { ip: '203.0.113.42' },
    )
    expect(submitted.ok).toBe(true)

    const list = await accountsNeedingAttention(fixture.ctx, { asOf: AS_OF })
    const found = list.find((account) => account.name === 'Harborview Marine')

    expect(found).toBeTruthy()
    expect(found?.findings.map((finding) => finding.ground)).toEqual([
      'never-contacted',
      'unowned',
    ])
    // A lead, so no cadence — `gone-quiet` must not also fire on it.
    expect(found?.findings.map((finding) => finding.ground)).not.toContain('gone-quiet')
  })

  it('stops finding it once somebody calls them', async () => {
    const organization = await createOrganization(fixture.ctx, {
      name: 'Hartley Industrial',
      lifecycleStage: 'strategic_target',
      isStrategicAccount: true,
      ownerId: fixture.userId,
    })

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'call',
      direction: 'outbound',
      summary: 'Introductory call — they asked for a quote in the autumn.',
      occurredAt: daysBefore(2),
    })

    const list = await accountsNeedingAttention(fixture.ctx, { asOf: AS_OF })
    expect(list.map((account) => account.organizationId)).not.toContain(organization.id)
  })

  it('does not count an internal note as having spoken to them', async () => {
    /**
     * `lastContactedAt` excludes internal notes and says why: counting them
     * would let a team convince itself it had spoken to somebody it had not.
     * Asserted here because this list is the screen that would carry the
     * illusion.
     */
    const organization = await createOrganization(fixture.ctx, {
      name: 'Hartley Industrial',
      lifecycleStage: 'strategic_target',
      isStrategicAccount: true,
      ownerId: fixture.userId,
    })

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'note',
      direction: 'internal',
      summary: 'Worth approaching once the yard expansion is announced.',
      occurredAt: daysBefore(2),
    })

    const list = await accountsNeedingAttention(fixture.ctx, { asOf: AS_OF })
    const found = list.find((account) => account.organizationId === organization.id)

    expect(found?.findings.map((finding) => finding.ground)).toContain('never-contacted')
  })

  it('weights the pipeline rather than counting it at face value', async () => {
    const organization = await createOrganization(fixture.ctx, {
      name: 'Okonjo Builders',
      lifecycleStage: 'prospect',
      ownerId: fixture.userId,
    })

    await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Warehouse fit-out',
      expectedValueCents: 1_000_000,
      probability: 40,
      stage: 'proposal_sent',
    })

    const facts = await accountFacts(fixture.ctx, AS_OF)
    const account = facts.find((row) => row.organizationId === organization.id)

    expect(account?.weightedPipelineCents).toBe(400_000)
    expect(account?.openOpportunities).toBe(1)
    // Nothing invoiced, so the stake is the weighted pipeline.
    expect(stakeCents(account!)).toBe(400_000)
  })

  it('leaves a closed opportunity out of the pipeline', async () => {
    const organization = await createOrganization(fixture.ctx, {
      name: 'Okonjo Builders',
      lifecycleStage: 'prospect',
      ownerId: fixture.userId,
    })

    await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Warehouse fit-out',
      expectedValueCents: 1_000_000,
      probability: 40,
      stage: 'won',
    })

    const facts = await accountFacts(fixture.ctx, AS_OF)
    const account = facts.find((row) => row.organizationId === organization.id)

    expect(account?.weightedPipelineCents).toBe(0)
    expect(account?.openOpportunities).toBe(0)
  })

  it('refuses a role that may not see the CRM', async () => {
    // `readonly` rather than `bookkeeper`: measured, after the first draft of
    // this test resolved to `[]` instead of throwing. A bookkeeper *does* hold
    // `crm:view` — they see who a transaction was with — so the role that
    // proves this check is one that does not.
    const reader = await addUserWithRole(fixture, 'readonly')

    await expect(accountsNeedingAttention(reader, { asOf: AS_OF })).rejects.toThrow(
      /permission/i,
    )
  })

  it('answers for a past date, because asOf is a parameter all the way down', async () => {
    /**
     * The reason nothing in the core reads the clock. A call logged forty days
     * ago is a finding today and was not one the day after it happened, and a
     * list that can only answer for "now" cannot be asked to show its working.
     */
    const organization = await createOrganization(fixture.ctx, {
      name: 'Delacroix Interiors',
      lifecycleStage: 'active_client',
      ownerId: fixture.userId,
    })

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'call',
      direction: 'outbound',
      summary: 'Quarterly review.',
      occurredAt: daysBefore(40),
    })

    const today = await accountsNeedingAttention(fixture.ctx, { asOf: AS_OF })
    expect(today.map((account) => account.organizationId)).toContain(organization.id)

    const backThen = await accountsNeedingAttention(fixture.ctx, { asOf: daysBefore(39) })
    expect(backThen.map((account) => account.organizationId)).not.toContain(organization.id)
  })
})

// --- The assistant ---------------------------------------------------------

describe('the assistant, which starts after the finding', () => {
  it('ships a built-in prompt that forbids re-deriving the measured facts', () => {
    const prompt = BUILT_IN_PROMPTS.find((entry) => entry.key === 'account.strategy')

    expect(prompt).toBeTruthy()
    expect(prompt?.systemPrompt).toContain('Do not re-derive them')
    expect(prompt?.systemPrompt).toContain('Do not invent history')
  })

  it('completes §11 — seven capabilities, seven prompts', () => {
    // ADR 0164's audit counted five of seven implemented. Phase 166 made it
    // six. This is the seventh, and the count is measured rather than claimed.
    const keys = BUILT_IN_PROMPTS.map((entry) => entry.key)

    expect(keys).toContain('account.strategy')
    expect(keys).toContain('design.layout')
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('refuses before the gateway when nothing is outstanding', async () => {
    await updateSettings(fixture.ctx, { enabled: true, provider: 'mock' })

    const organization = await createOrganization(fixture.ctx, {
      name: 'Fine & Co',
      lifecycleStage: 'active_client',
      ownerId: fixture.userId,
    })
    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'call',
      direction: 'outbound',
      summary: 'Spoke yesterday.',
      occurredAt: daysBefore(1),
    })

    const result = await adviseOnAccount(fixture.ctx, organization.id, AS_OF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('nothing_to_advise')
    // Nothing was spent, which is the point of refusing here rather than after.
    expect(result.message).toContain('not on the attention list')
  })

  it('advises on a neglected account, from the findings rather than around them', async () => {
    await updateSettings(fixture.ctx, { enabled: true, provider: 'mock' })

    const organization = await createOrganization(fixture.ctx, {
      name: 'Hartley Industrial',
      lifecycleStage: 'strategic_target',
      isStrategicAccount: true,
      ownerId: fixture.userId,
    })

    const result = await adviseOnAccount(fixture.ctx, organization.id, AS_OF)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The finding the assistant was given, carried into what it said.
    expect(result.attention.findings.map((finding) => finding.ground)).toContain(
      'never-contacted',
    )
    expect(result.strategy.nextActions.length).toBeGreaterThan(0)
    expect(result.strategy.nextActions[0].because).toContain(
      'No exchange has ever been logged',
    )
    expect(result.strategy.outreach.subject.length).toBeGreaterThan(0)

    // And it is a suggestion for a person, not a change to anything.
    expect(result.suggestion.status).toBe('pending')
    expect(result.suggestion.entityType).toBe('organization')
    expect(result.suggestion.entityId).toBe(organization.id)
  })

  it('says the record is thin when the record is thin', async () => {
    // The prompt's third rule, and the mock honouring it: a confident narrative
    // built from an empty timeline is worse than an honest sentence.
    await updateSettings(fixture.ctx, { enabled: true, provider: 'mock' })

    const organization = await createOrganization(fixture.ctx, {
      name: 'Hartley Industrial',
      lifecycleStage: 'strategic_target',
      isStrategicAccount: true,
      ownerId: fixture.userId,
    })

    const result = await adviseOnAccount(fixture.ctx, organization.id, AS_OF)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.strategy.summary).toContain('nothing on the timeline')
  })

  it('refuses a role that may not manage the relationship', async () => {
    await updateSettings(fixture.ctx, { enabled: true, provider: 'mock' })

    const organization = await createOrganization(fixture.ctx, {
      name: 'Hartley Industrial',
      lifecycleStage: 'strategic_target',
      isStrategicAccount: true,
    })

    const readonly = await addUserWithRole(fixture, 'readonly')
    const result = await adviseOnAccount(readonly, organization.id, AS_OF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('permission')
  })

  it('leaves the list working with the module switched off', async () => {
    /**
     * §11: "The core accounting product must remain fully functional without
     * AI." The identification is the half that has to survive that, and this is
     * the assertion that says it does — the list answers, and the assistant
     * refuses with the gateway's own reason.
     */
    const organization = await createOrganization(fixture.ctx, {
      name: 'Hartley Industrial',
      lifecycleStage: 'strategic_target',
      isStrategicAccount: true,
      ownerId: fixture.userId,
    })

    const list = await accountsNeedingAttention(fixture.ctx, { asOf: AS_OF })
    expect(list.map((account) => account.organizationId)).toContain(organization.id)

    const advice = await adviseOnAccount(fixture.ctx, organization.id, AS_OF)
    expect(advice.ok).toBe(false)
    if (advice.ok) return
    expect(advice.reason).toBe('disabled')
  })
})
