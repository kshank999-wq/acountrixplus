import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, invoices, journalEntries, journalLines, proposals } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createOpportunity, createOrganization, changeStage } from '@/modules/crm/opportunities'
import {
  createProposal,
  sendProposal,
  setBillingSchedule,
  decideProposal,
} from '@/modules/crm/proposals'
import { convertWonOpportunity } from '@/modules/crm/conversion'
import { billStage, stagesDue } from '@/modules/crm/stage-invoicing'
import { acceptProposal } from '@/modules/crm/acceptance'
import { runOnce } from '@/modules/worker/runner'
import { Refusal } from '@/modules/errors'

/**
 * Billing a contract in stages, and the deposit that signing raises (Phase 155).
 *
 * Phase 154 gave a proposal a schedule and left two things, both of which ADR
 * 0154 named: nothing could bill a stage unless the company ran job costing, and
 * the deposit was never recognised as revenue.
 */

let fixture: Fixture
let opportunityId: string
let proposalId: string
let revenueNumber: string

/** $20,000: 25% on signing, 25% at the frame, 50% on handover. */
const CONTRACT = 2_000_000

beforeEach(async () => {
  fixture = await createCompanyFixture()
  const revenue = await fixture.account('4000')
  revenueNumber = '4000'

  const organization = await createOrganization(fixture.ctx, { name: 'Harborview' })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Workshop fit-out',
    expectedValueCents: CONTRACT,
  })
  opportunityId = opportunity.id

  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Fit-out proposal',
    items: [
      { description: 'Fit-out', unitPriceCents: CONTRACT, chartAccountId: revenue.id },
    ],
  })
  proposalId = proposal.id

  await setBillingSchedule(fixture.ctx, proposalId, [
    { label: 'On signing', kind: 'deposit', percentBp: 2_500 },
    { label: 'Frame complete', kind: 'milestone', percentBp: 2_500 },
    { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
  ])
})

/** What one account was debited and credited across every posted entry. */
async function movement(number: string): Promise<{ debit: number; credit: number }> {
  const rows = await db
    .select({ debit: journalLines.debitCents, credit: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, number)))

  return {
    debit: rows.reduce((total, row) => total + row.debit, 0),
    credit: rows.reduce((total, row) => total + row.credit, 0),
  }
}

async function won() {
  await sendProposal(fixture.ctx, proposalId)
  await decideProposal(fixture.ctx, proposalId, 'won')
  await changeStage(fixture.ctx, opportunityId, { stage: 'won' })
  return convertWonOpportunity(fixture.ctx, opportunityId, { createInvoice: false })
}

describe('billing a contract one stage at a time', () => {
  it('bills the stages in order, to the contract, and no further', async () => {
    await won()

    const first = await billStage(fixture.ctx, { proposalId, stageIndex: 0 })
    expect(first.amountCents).toBe(500_000)

    const second = await billStage(fixture.ctx, { proposalId, stageIndex: 1 })
    expect(second.amountCents).toBe(500_000)

    const third = await billStage(fixture.ctx, { proposalId, stageIndex: 2 })
    expect(third.amountCents).toBe(1_000_000)

    // Three invoices, and together they are the contract. Not the contract plus
    // a deposit, and not the contract less one: the stages come to 100%.
    const raised = await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(3)
    expect(raised.reduce((sum, invoice) => sum + invoice.totalCents, 0)).toBe(CONTRACT)

    const due = await stagesDue(fixture.ctx, proposalId)
    expect(due.next).toBeNull()
    expect(due.billedCents).toBe(CONTRACT)
    expect(due.remainingCents).toBe(0)
  })

  it('refuses a stage that is already invoiced', async () => {
    await won()
    await billStage(fixture.ctx, { proposalId, stageIndex: 0 })

    await expect(
      billStage(fixture.ctx, { proposalId, stageIndex: 0 }),
    ).rejects.toThrow(/already been invoiced/)
  })

  it('refuses a stage whose predecessor is not billed', async () => {
    // Order is a decision, not an accident: billing the handover first is either
    // a mistake or a change to the contract, and letting it through would let a
    // job be billed to completion with the work in between never appearing.
    await won()

    await expect(
      billStage(fixture.ctx, { proposalId, stageIndex: 2 }),
    ).rejects.toThrow(/comes before/)
  })

  it('refuses a stage before there is a client to invoice', async () => {
    // Won but not converted: the opportunity has no customer yet, so there is
    // nobody for the invoice to go to. Refused with that sentence rather than
    // failing inside `createInvoice`.
    await sendProposal(fixture.ctx, proposalId)
    await decideProposal(fixture.ctx, proposalId, 'won')

    await expect(billStage(fixture.ctx, { proposalId, stageIndex: 0 })).rejects.toThrow(Refusal)
  })

  it('needs no job-costing module', async () => {
    // The capability Phase 154 could describe and not reach. The fixture company
    // does not run `job_costing`, and all three stages bill.
    await won()
    for (const stageIndex of [0, 1, 2]) {
      await billStage(fixture.ctx, { proposalId, stageIndex })
    }

    expect((await stagesDue(fixture.ctx, proposalId)).remainingCents).toBe(0)
  })
})

describe('what the deposit does to the books', () => {
  it('credits unearned revenue, not revenue, when it is billed', async () => {
    await won()
    await billStage(fixture.ctx, { proposalId, stageIndex: 0 })

    // $5,000 held, nothing earned. The client owes it and the company has not
    // done the work.
    expect((await movement('2500')).credit).toBe(500_000)
    expect((await movement(revenueNumber)).credit).toBe(0)
  })

  it('earns it on the last stage, once', async () => {
    await won()
    await billStage(fixture.ctx, { proposalId, stageIndex: 0 })
    await billStage(fixture.ctx, { proposalId, stageIndex: 1 })

    // Still held: the contract is not finished.
    expect((await movement('2500')).debit).toBe(0)
    expect((await movement(revenueNumber)).credit).toBe(500_000)

    const last = await billStage(fixture.ctx, { proposalId, stageIndex: 2 })
    expect(last.recognitionEntryId).not.toBeNull()

    // The liability is square, and revenue is the whole contract — not 75% of it
    // with a quarter stranded in a liability for ever, which is what billing
    // every stage did before this phase.
    const held = await movement('2500')
    expect(held.credit).toBe(500_000)
    expect(held.debit).toBe(500_000)
    expect((await movement(revenueNumber)).credit).toBe(CONTRACT)

    // Recorded on the proposal, so a second run cannot post it twice.
    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
    expect(row.depositRecognisedEntryId).toBe(last.recognitionEntryId)
  })

  it('leaves the books alone when the contract has no deposit', async () => {
    await setBillingSchedule(fixture.ctx, proposalId, [
      { label: 'Halfway', kind: 'milestone', percentBp: 5_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ])
    await won()

    const last = await billStage(fixture.ctx, { proposalId, stageIndex: 0 })
    expect(last.recognitionEntryId).toBeNull()
    const final = await billStage(fixture.ctx, { proposalId, stageIndex: 1 })
    expect(final.recognitionEntryId).toBeNull()

    // Nothing was ever held, so nothing is recognised and revenue is the whole
    // contract from the invoices alone.
    expect((await movement('2500')).credit).toBe(0)
    expect((await movement(revenueNumber)).credit).toBe(CONTRACT)
  })

  it('names the recognition in a sentence an accountant can read', async () => {
    await won()
    for (const stageIndex of [0, 1, 2]) {
      await billStage(fixture.ctx, { proposalId, stageIndex })
    }

    const [entry] = await db
      .select({ memo: journalEntries.memo })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.sourceType, 'proposal'),
        ),
      )

    expect(entry.memo).toMatch(/deposit earned on completion/)
  })
})

describe('the deposit a signature raises, digitally', () => {
  it('converts and invoices the deposit without anybody clicking anything', async () => {
    // The gap Phase 155 closes. `acceptProposal` marked the deal won and
    // stopped: the client had signed and the deposit the contract asks for did
    // not exist until somebody noticed and clicked Convert. A deposit invoiced
    // on Monday because a human got round to it is a deposit that did not do its
    // job over the weekend.
    await sendProposal(fixture.ctx, proposalId)

    const accepted = await acceptProposal(
      (await db.select().from(proposals).where(eq(proposals.id, proposalId)))[0].publicToken,
      {
        signerName: 'Dana Reyes',
        signerEmail: 'dana@harborview.test',
        signatureText: 'Dana Reyes',
        selectedItemIds: [],
        agreed: true,
      },
    )
    expect(accepted.ok).toBe(true)

    // The outbox, then the job. Both are the ordinary worker path: the event was
    // written inside the acceptance transaction, so it exists exactly when the
    // signature does.
    await runOnce()

    const raised = await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(1)
    expect(raised[0].totalCents).toBe(500_000)

    // Held, not earned — the signature is not the work.
    expect((await movement('2500')).credit).toBe(500_000)
    expect((await movement(revenueNumber)).credit).toBe(0)

    // And the stage knows which invoice billed it, so nothing bills it again.
    const due = await stagesDue(fixture.ctx, proposalId)
    expect(due.next?.label).toBe('Frame complete')
    expect(due.billedCents).toBe(500_000)
  })

  it('does not bill twice when the job runs again', async () => {
    // The queue promises at least once (Phase 10), so this is not a hypothetical.
    await sendProposal(fixture.ctx, proposalId)
    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))

    await acceptProposal(row.publicToken, {
      signerName: 'Dana Reyes',
      signatureText: 'Dana Reyes',
      selectedItemIds: [],
      agreed: true,
    })

    // Twice, because the queue promises at least once and `runOnce` relays and
    // runs in one tick.
    await runOnce()
    await runOnce()

    const raised = await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(1)
  })

  it('raises nothing on signing when the first stage is not a deposit', async () => {
    // A contract billed halfway and on handover asks for nothing at signature,
    // and the handler says so rather than inventing a first invoice.
    await setBillingSchedule(fixture.ctx, proposalId, [
      { label: 'Halfway', kind: 'milestone', percentBp: 5_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ])
    await sendProposal(fixture.ctx, proposalId)
    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))

    await acceptProposal(row.publicToken, {
      signerName: 'Dana Reyes',
      signatureText: 'Dana Reyes',
      selectedItemIds: [],
      agreed: true,
    })

    await runOnce()

    const raised = await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(0)

    // But the client and the job exist, so the first milestone can be billed
    // when the work reaches it.
    const due = await stagesDue(fixture.ctx, proposalId)
    expect(due.next?.label).toBe('Halfway')
  })
})

describe('one contract, one billing path', () => {
  it('refuses a stage once the job is billed by progress application', async () => {
    // The hole this phase would otherwise have opened. Conversion writes the
    // earning stages onto the job's schedule of values, and
    // `createProgressBilling` bills against that — so making stages billable
    // without this check would have made Phase 155 the way to bill a job twice.
    const { setModuleEnabled } = await import('@/modules/industry/modules')
    await setModuleEnabled(fixture.ctx, 'job_costing', true)

    const converted = await won()

    const { setScheduleOfValues, createProgressBilling } = await import('@/modules/jobs/billing')
    const revenue = await fixture.account('4000')
    const sov = await setScheduleOfValues(fixture.ctx, converted.projectId, [
      {
        itemNumber: '001',
        description: 'Fit-out',
        scheduledValueCents: CONTRACT,
        chartAccountId: revenue.id,
      },
    ])

    await createProgressBilling(fixture.ctx, {
      projectId: converted.projectId,
      customerId: converted.customerId,
      periodEnd: '2026-06-30',
      billingDate: '2026-06-30',
      retainagePercentBp: 0,
      lines: [{ scheduleOfValuesId: sov[0].id, thisPeriodCents: 500_000 }],
    })

    await expect(
      billStage(fixture.ctx, { proposalId, stageIndex: 0 }),
    ).rejects.toThrow(/charge the client twice for the same work/)
  })

  it('allows stages when the job has no applications', async () => {
    // The check is exclusive, not a ban: a job-costing company that bills by
    // stage rather than by application is doing something ordinary.
    const { setModuleEnabled } = await import('@/modules/industry/modules')
    await setModuleEnabled(fixture.ctx, 'job_costing', true)
    await won()

    const billed = await billStage(fixture.ctx, { proposalId, stageIndex: 0 })
    expect(billed.amountCents).toBe(500_000)
  })
})
