import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { proposalStatusEnum, proposals } from '@/db/schema'
import { formatCents } from '@/lib/money'
import { proposalStats } from '@/modules/crm/analytics'
import { isAcceptable } from '@/modules/crm/acceptance'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import {
  createProposal,
  decideProposal,
  lapseExpiredProposals,
  sendProposal,
} from '@/modules/crm/proposals'
import { businessInsights } from '@/modules/ai/assistants'
import { BUILT_IN_PROMPTS, resolvePrompt } from '@/modules/ai/prompts'
import { mockAiProvider } from '@/modules/ai/registry'
import { updateSettings } from '@/modules/ai/settings'
import { createJournalEntry } from '@/modules/ledger/journal'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * The seventh status, and the figure that was never supplied (Phase 195).
 *
 * ADR 0194 nominated §9's and §11's gap rows — both written in Phase 173,
 * both patched once, neither re-measured since — on the grounds that a list
 * in a cell amended in place is the shape this process had found wrong four
 * times out of five in §7.
 *
 * Measured, both rows are wrong, and in the direction the audit's §7 rows
 * were not: they claim **more** than is there.
 *
 * ## §11: "seven of seven AI capabilities"
 *
 * Seven of seven *rows*, yes. But each row's Function cell lists several
 * things, and counted that way §11 asks for **thirty-three** and had
 * twenty-three. The ten missing were reusable proposal content, brand
 * variations, logo ideation, segment suggestion, follow-up timing, nurture
 * sequences, campaign voice, and three of Business Insights' six. This phase
 * builds two of them, leaving twenty-five.
 *
 * Those two are the sharp ones, because they were not absent — they were
 * *asked for and starved*. `insights.business`'s own first rule is that
 * **"every insight must be traceable to a figure you were given"**, and §11
 * asks that capability to explain *"expense changes"* and *"cash-flow
 * trends"*. It was given no expense figure at all, and for cash a single
 * balance, which is a position rather than a trend. So it did exactly the
 * right thing with what it had: it said nothing about either, and the silence
 * read as a quiet month rather than a missing input.
 *
 * `comparativeProfitAndLoss` has produced two columns of a real profit and
 * loss since §13's comparative periods were built, and `cashFlowStatement` has
 * stated opening, closing and net movement since Phase 33. The calls were
 * simply never made.
 *
 * The third, *"operational trends"*, stays a gap and is named as one in the
 * audit: nothing operational reaches that prompt, and unlike these two it
 * needs a figure chosen rather than a call made.
 *
 * ## §9: "four real gaps (all four built in Phase 168)"
 *
 * The four are built. What the row does not say is that §9's **first** bullet
 * — *"counts and value by Draft, Sent, Viewed, Won, Lost, Expired, and No
 * Decision"* — was six-sevenths true. `proposalStatusEnum` has carried all
 * seven since Phase 3 and **nothing in the application ever set `expired`**.
 *
 * Every other part of it was here: `proposals.expires_on` is recorded, the
 * client-facing page has refused a lapsed proposal since Phase 3, and
 * `serviceBreakdown` already classifies `expired` beside `lost`. The company's
 * dashboard went on counting a lapsed proposal as sent and awaiting a reply
 * while the link it was sent on told the client it had expired — two documents
 * disagreeing, which is the defect this project names most often.
 *
 * It is also the fourth consecutive phase to find the same thing: a build
 * nobody ran (192), a function nobody called (193), a price nobody re-read
 * (194), a status nobody wrote (195).
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Varga Interiors' })
})

async function aProposal(opts: { title: string; expiresOn?: string | null; send?: boolean }) {
  const organization = await createOrganization(fixture.ctx, { name: `Client ${opts.title}` })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: opts.title,
    expectedValueCents: 500_000,
  })

  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: opts.title,
    items: [{ description: 'Design and install', unitPriceCents: 500_000 }],
  })

  if (opts.send ?? true) await sendProposal(fixture.ctx, proposal.id)

  if (opts.expiresOn !== undefined) {
    await db
      .update(proposals)
      .set({ expiresOn: opts.expiresOn })
      .where(eq(proposals.id, proposal.id))
  }

  return proposal
}

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

async function statusOf(proposalId: string): Promise<string> {
  const [row] = await db
    .select({ status: proposals.status, decidedAt: proposals.decidedAt })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
  return row.status
}

// --- §9: the status nobody wrote -------------------------------------------

describe('a proposal that ran out of time', () => {
  it('lapses, where one still in date and one never sent do not', async () => {
    const lapsing = await aProposal({ title: 'Lapsing', expiresOn: dayOffset(-1) })
    const live = await aProposal({ title: 'Live', expiresOn: dayOffset(14) })
    const openEnded = await aProposal({ title: 'Open ended', expiresOn: null })

    /*
      A draft with a date in the past is deliberately in here. A proposal
      nobody sent cannot expire — there is no offer outstanding to run out —
      and `sent` and `viewed` are the two statuses `isAcceptable` lets a
      client act on.
    */
    const draft = await aProposal({ title: 'Draft', expiresOn: dayOffset(-30), send: false })

    const result = await lapseExpiredProposals(fixture.ctx)

    expect(result.lapsed).toBe(1)
    expect(result.numbers).toEqual([lapsing.number])

    expect(await statusOf(lapsing.id)).toBe('expired')
    expect(await statusOf(live.id)).toBe('sent')
    expect(await statusOf(openEnded.id)).toBe('sent')
    expect(await statusOf(draft.id)).toBe('draft')
  })

  it('agrees with the page the client is looking at, to the day', async () => {
    /*
      The whole defect was these two disagreeing, so the test is that they
      agree rather than that each is independently plausible.

      `expires_on` is the last day the proposal is good for: a proposal
      expiring today is acceptable today. `isAcceptable` has read it that way
      since Phase 3 and the sweep uses `lt` to match.
    */
    const today = await aProposal({ title: 'Expires today', expiresOn: dayOffset(0) })
    const yesterday = await aProposal({ title: 'Expired yesterday', expiresOn: dayOffset(-1) })

    expect(isAcceptable({ status: 'sent', expiresOn: dayOffset(0) })).toBe(true)
    expect(isAcceptable({ status: 'sent', expiresOn: dayOffset(-1) })).toBe(false)

    await lapseExpiredProposals(fixture.ctx)

    expect(await statusOf(today.id)).toBe('sent')
    expect(await statusOf(yesterday.id)).toBe('expired')
  })

  it('records no decision, because nobody made one', async () => {
    /**
     * §9's *"average time to decision"* counts every proposal carrying both
     * `sent_at` and `decided_at`. A deadline passing is the **absence** of a
     * decision, so stamping `decided_at` would have fed every lapse into that
     * mean at exactly whatever validity window the company happens to set —
     * dragging a §9 figure toward a number nobody chose.
     *
     * This is why `decideProposal` no longer accepts `expired` at all: two
     * writers of one status with different side effects is two answers to one
     * question. Somebody closing a lapsed proposal by hand has `no_decision`,
     * which is what that is.
     */
    const lapsed = await aProposal({ title: 'Lapsed', expiresOn: dayOffset(-2) })
    const decided = await aProposal({ title: 'Decided' })
    await decideProposal(fixture.ctx, decided.id, 'lost')

    await lapseExpiredProposals(fixture.ctx)

    const [row] = await db
      .select({ decidedAt: proposals.decidedAt })
      .from(proposals)
      .where(eq(proposals.id, lapsed.id))
    expect(row.decidedAt).toBeNull()

    const stats = await proposalStats(fixture.ctx)
    expect(stats.byStatus.expired.count).toBe(1)
    // One, not two: the lapse is not in the denominator.
    expect(stats.decidedCount).toBe(1)
  })

  it('lapses once however often the sweep runs', async () => {
    await aProposal({ title: 'Lapsing', expiresOn: dayOffset(-1) })

    expect((await lapseExpiredProposals(fixture.ctx)).lapsed).toBe(1)
    // The precondition is in the query rather than in the handler, which is
    // what makes the schedule safe to retry.
    expect((await lapseExpiredProposals(fixture.ctx)).lapsed).toBe(0)
  })

  it('reports every status §9 names, including the ones at zero', async () => {
    /*
      Built from the query's rows alone, `byStatus` held only the statuses that
      happened to have a proposal, in whatever order they came back. That
      ambiguity — between "none" and "not reported" — is how a status with no
      writer stayed invisible for a hundred and ninety phases: the dashboard
      showed exactly what it shows for a status with no rows, which is
      nothing.
    */
    await aProposal({ title: 'Only one', expiresOn: null })

    const stats = await proposalStats(fixture.ctx)

    expect(Object.keys(stats.byStatus)).toEqual([
      'draft',
      'sent',
      'viewed',
      'won',
      'lost',
      'expired',
      'no_decision',
    ])
    // The enum is the source, so a status added to the schema appears here
    // without this test being edited.
    expect(Object.keys(stats.byStatus)).toEqual([...proposalStatusEnum.enumValues])
    expect(stats.byStatus.expired).toEqual({ count: 0, valueCents: 0 })
    expect(stats.byStatus.sent.count).toBe(1)
  })
})

// --- §11: the figure that was never supplied -------------------------------

/** A company with AI on, and a profit and loss in two months. */
async function withTwoMonths(): Promise<Fixture> {
  const company = await createCompanyFixture({ name: 'Varga Books' })
  await updateSettings(company.ctx, { enabled: true, provider: 'mock' })

  const rent = await company.account('6400')
  const revenue = await company.account('4000')
  const cash = await company.account('1000')

  for (const month of [
    { entryDate: '2026-04-10', expense: 40_000, income: 100_000 },
    { entryDate: '2026-05-10', expense: 60_000, income: 120_000 },
  ]) {
    await createJournalEntry(
      company.ctx,
      {
        entryDate: month.entryDate,
        memo: 'Rent',
        lines: [
          { chartAccountId: rent.id, debitCents: month.expense },
          { chartAccountId: cash.id, creditCents: month.expense },
        ],
      },
      db,
    )

    await createJournalEntry(
      company.ctx,
      {
        entryDate: month.entryDate,
        memo: 'Fees',
        lines: [
          { chartAccountId: cash.id, debitCents: month.income },
          { chartAccountId: revenue.id, creditCents: month.income },
        ],
      },
      db,
    )
  }

  return company
}

/** Mid-May, so the window is May and the comparison is April. */
const MID_MAY = new Date('2026-05-15T00:00:00Z')

describe('what Business Insights is given', () => {
  beforeEach(() => {
    mockAiProvider().reset()
  })

  it('puts the expense change in the prompt, with the period it is against', async () => {
    const company = await withTwoMonths()

    const result = await businessInsights(company.ctx, MID_MAY)
    if (!result.ok) throw new Error(result.message)

    /*
      Asserted on what the provider was *sent* rather than on what the mock
      said about it. The defect was an input that never arrived; a test reading
      the answer would pass against a model that invented the figure, which is
      the one outcome this prompt's first rule forbids.
    */
    const [call] = mockAiProvider().calls
    expect(call.prompt).toContain(formatCents(60_000))
    expect(call.prompt).toContain(formatCents(40_000))
    expect(call.prompt).toContain('2026-04-01 to 2026-04-30')
    // 60,000 against 40,000 is half again as much.
    expect(call.prompt).toContain('50.0% higher')
    expect(call.prompt).toContain('(was ')
  })

  it('states cash as a movement rather than a position', async () => {
    /**
     * §11's other starved bullet. The call had always passed a cash
     * *balance*, and a balance cannot be a trend however it is worded — so
     * the prompt could not explain one without inventing it, which its first
     * rule forbids.
     *
     * `cashFlowStatement` has said where cash started, where it finished and
     * what moved it since Phase 33. This is the figure, not a new one.
     */
    const company = await withTwoMonths()
    await businessInsights(company.ctx, MID_MAY)

    const [call] = mockAiProvider().calls

    /*
      May's cash: opens at the April balance (100,000 in, 40,000 out) and
      closes 60,000 higher (120,000 in, 60,000 out). The net is the movement
      the period caused, which is what makes it a trend rather than a reading.
    */
    expect(call.prompt).toContain(`Cash over 2026-05-01 to 2026-05-31`)
    expect(call.prompt).toContain(`${formatCents(60_000)} to ${formatCents(120_000)}`)
    expect(call.prompt).toContain(`(net ${formatCents(60_000)})`)
  })

  it('tells the model that a change outranks a level', async () => {
    const company = await withTwoMonths()
    await businessInsights(company.ctx, MID_MAY)

    const [call] = mockAiProvider().calls
    expect(call.system).toMatch(/change\*\* is usually the insight/)
    // And told not to read the one figure it already had as the other thing.
    expect(call.system).toContain('do not call a single balance a trend')
    // The rule that made the old silence correct, kept rather than relaxed.
    expect(call.system).toContain('traceable to a figure you were given')
  })

  it('leaves the section out for a role that may not read the accounts', async () => {
    /**
     * A manager has `reports:view` and `ai:use` and not `reports:financial`,
     * so this call succeeds and the figures are withheld.
     *
     * Withheld as an **absent section**, not as zeroes. A prompt reading
     * "Operating expenses: $0.00 (was $0.00)" is a prompt the model would have
     * had to explain, and the honest explanation — that a company spent
     * nothing in two months — is false. The system prompt says some figures
     * may be absent and not to remark on them.
     */
    const company = await withTwoMonths()
    const manager = await addUserWithRole(company, 'manager')

    const result = await businessInsights(manager, MID_MAY)
    if (!result.ok) throw new Error(result.message)

    const [call] = mockAiProvider().calls
    expect(call.prompt).not.toContain('Operating expenses')
    expect(call.prompt).not.toContain('2026-04-01 to 2026-04-30')
    expect(call.prompt).not.toContain('Cash over')
    // `(was ` appears nowhere but the comparison block, so no prior-period
    // figure can reach this prompt by another route.
    expect(call.prompt).not.toContain('(was ')
    // The figures this role may see are still there.
    expect(call.prompt).toContain('Cash:')

    /*
      Cash and receivables read $0.00 here for both roles, because this fixture
      posts journal entries rather than bank transactions and invoices — those
      two figures come from `bank_transactions` and `invoices`. Said out loud
      because a zero beside a withheld section looks like the withholding and
      is not: `reports:view` is the gate those reads have always had.
    */
  })
})

describe('the prompt registry kept its history', () => {
  it('resolves to version 2 and keeps version 1 for the rows that cite it', async () => {
    /**
     * §12 asks for a prompt registry with *"versioning, testing, and
     * rollback"*, and the gateway writes `promptVersion` into every
     * `ai_requests` row. So editing version 1 in place would have changed
     * history under rows that already cite it — a version that can be
     * rewritten is not a version, and rollback would roll back to the new
     * text.
     *
     * `resolvePrompt` takes the highest built-in version, so adding v2 is what
     * switches the behaviour over; v1 staying put is what keeps the ledger
     * honest.
     */
    const company = await createCompanyFixture({ name: 'Varga Versions' })

    const resolved = await resolvePrompt(company.companyId, 'insights.business')
    expect(resolved.version).toBe(2)
    expect(resolved.source).toBe('built-in')
    expect(resolved.template).toContain('{{comparisonBlock}}')

    const versions = BUILT_IN_PROMPTS.filter((p) => p.key === 'insights.business').map(
      (p) => p.version,
    )
    expect(versions).toEqual([1, 2])

    const [v1] = BUILT_IN_PROMPTS.filter((p) => p.key === 'insights.business' && p.version === 1)
    expect(v1.template).not.toContain('{{comparisonBlock}}')
  })
})
