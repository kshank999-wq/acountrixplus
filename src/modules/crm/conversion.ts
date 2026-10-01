import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  customers,
  opportunities,
  organizations,
  projects,
  proposalItems,
  proposals,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { createInvoice } from '@/modules/receivables/service'
import { logActivity } from './opportunities'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import {
  depositStage,
  scheduleAmounts,
  scheduleStands,
  sovStages,
  type ScheduledStage,
} from './billing-schedule'
import { billingSchedule } from './proposals'
import { setScheduleOfValues } from '@/modules/jobs/billing'
import { moduleEnabled } from '@/modules/industry/modules'
import { resolveRetainerAccount } from '@/modules/timebilling/billing'

/**
 * Turning a win into work (spec §6).
 *
 * "Won proposal can create a client, job/project, contract, invoice schedule,
 * and accounting dimensions without re-entry." This is the seam where the CRM
 * hands off to accounting, and it is the clearest expression of the §23 rule
 * that data entered once should flow through the business lifecycle.
 *
 * Conversion is idempotent: an opportunity already converted returns what it
 * created rather than making a second client and a second job.
 */

export type ConversionResult = {
  customerId: string
  projectId: string
  /**
   * The deposit invoice, when the proposal's schedule asks for one (Phase 154).
   *
   * Was the whole proposal, invoiced on the day of conversion. Spec §6 asks for
   * an invoice *schedule* and this module quoted that sentence while billing a
   * $500,000 contract in full on signing day — revenue recognised for work not
   * performed, and a job overbilled by its entire value from the moment it
   * existed.
   *
   * A deposit invoice is the one thing that genuinely is payable at conversion,
   * and it posts to the unearned revenue account rather than to revenue, because
   * money taken before any work is a liability until it is earned.
   */
  depositInvoiceId: string | null
  /** How many stages were written onto the job's schedule of values. */
  sovStageCount: number
  alreadyConverted: boolean
}

export async function convertWonOpportunity(
  ctx: ActorContext,
  opportunityId: string,
  opts: { createInvoice?: boolean; proposalId?: string; projectCode?: string } = {},
): Promise<ConversionResult> {
  requirePermission(ctx, 'crm:manage')

  const [row] = await db
    .select({ opportunity: opportunities, organization: organizations })
    .from(opportunities)
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(scoped(ctx, opportunities, eq(opportunities.id, opportunityId)))
    .limit(1)

  if (!row) throw missing('opportunity')
  const { opportunity, organization } = row

  if (opportunity.stage !== 'won') {
    throw new Refusal('Only a won opportunity can be converted to a client and job.')
  }

  // Idempotent: converting twice must not create a second client or job.
  if (opportunity.convertedCustomerId && opportunity.convertedProjectId) {
    return {
      customerId: opportunity.convertedCustomerId,
      projectId: opportunity.convertedProjectId,
      depositInvoiceId: null,
      sovStageCount: 0,
      alreadyConverted: true,
    }
  }

  const winningProposal = await findWinningProposal(ctx, opportunityId, opts.proposalId)
  const contractValueCents = winningProposal?.totalCents ?? opportunity.expectedValueCents

  const result = await db.transaction(async (tx) => {
    // Reuse the organization's existing customer record if it has one — a
    // repeat client should not accumulate duplicates.
    const [linkedCustomer] = await tx
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.companyId, ctx.companyId),
          eq(customers.organizationId, organization.id),
        ),
      )
      .limit(1)

    /**
     * ...and adopt one that was created on the accounting side (Phase 45).
     *
     * The check above only ever matched a customer already linked to this
     * organization, so a client invoiced before they were ever won in the CRM
     * — which is the ordinary order of events for a repeat customer — got a
     * **second** customer record here. Two records for one client split their
     * aging, their statement and their balance, and until Phase 45 there was
     * no screen on which anybody could even see it had happened. The demo seed
     * produced exactly this, twice over, which is how it was found.
     *
     * Adoption is narrow on purpose: an exact, case-insensitive name match, in
     * this company, on a customer belonging to **no** organization. One
     * already linked elsewhere is a different client who happens to share a
     * name, and is left alone.
     */
    const [adoptable] = linkedCustomer
      ? []
      : await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.companyId, ctx.companyId),
              isNull(customers.organizationId),
              sql`lower(${customers.name}) = lower(${organization.name})`,
            ),
          )
          .limit(1)

    if (adoptable) {
      await tx
        .update(customers)
        .set({ organizationId: organization.id })
        .where(eq(customers.id, adoptable.id))
    }

    const customer =
      linkedCustomer ??
      adoptable ??
      (
        await tx
          .insert(customers)
          .values({
            companyId: ctx.companyId,
            organizationId: organization.id,
            name: organization.name,
            email: organization.email,
            phone: organization.phone,
            addressLine1: organization.addressLine1,
            city: organization.city,
            region: organization.region,
            postalCode: organization.postalCode,
          })
          .returning()
      )[0]

    const code = opts.projectCode ?? (await nextProjectCode(ctx.companyId, tx))
    const [project] = await tx
      .insert(projects)
      .values({
        companyId: ctx.companyId,
        organizationId: organization.id,
        code,
        name: opportunity.title,
        status: 'active',
        contractValueCents,
        startDate: new Date().toISOString().slice(0, 10),
      })
      .returning()

    // The organization is a client now, not a lead.
    await tx
      .update(organizations)
      .set({ lifecycleStage: 'active_client', updatedAt: new Date() })
      .where(
        and(eq(organizations.id, organization.id), eq(organizations.companyId, ctx.companyId)),
      )

    await tx
      .update(opportunities)
      .set({
        convertedCustomerId: customer.id,
        convertedProjectId: project.id,
        updatedAt: new Date(),
      })
      .where(
        and(eq(opportunities.id, opportunityId), eq(opportunities.companyId, ctx.companyId)),
      )

    await logActivity(
      ctx,
      opportunityId,
      {
        kind: 'converted',
        summary: `Won — created client "${organization.name}" and job ${code}`,
        detail: { customerId: customer.id, projectId: project.id, contractValueCents },
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'opportunity.convert',
        entityType: 'opportunity',
        entityId: opportunityId,
        after: {
          customerId: customer.id,
          projectId: project.id,
          projectCode: code,
          contractValueCents,
        },
      },
      tx,
    )

    return { customerId: customer.id, projectId: project.id }
  })

  /**
   * The invoice schedule spec §6 asks for (Phase 154).
   *
   * A separate transaction from the client and the job, because it posts to the
   * ledger and can fail on its own terms — a closed period, a missing revenue
   * account. The client and job are correctly created either way.
   *
   * Two things come out of the proposal's stages and they are not the same kind
   * of thing:
   *
   * - the **milestones** become the job's schedule of values, which is what
   *   progress billing already draws against;
   * - the **deposit**, if there is one, becomes an invoice now — the one figure
   *   that genuinely is payable at conversion — posting to unearned revenue
   *   rather than to revenue, because money taken before any work is a liability
   *   until it is earned.
   *
   * A proposal with no stages gets neither, and that is deliberate: a schedule
   * invented at conversion would be payment terms nobody agreed to.
   */
  let depositInvoiceId: string | null = null
  let sovStageCount = 0

  if (opts.createInvoice && winningProposal) {
    const scheduled = await scheduleForProposal(ctx, winningProposal.id, winningProposal.totalCents)

    if (scheduled.length > 0) {
      sovStageCount = await scheduleOnJob(ctx, result.projectId, winningProposal.id, scheduled)
      depositInvoiceId = await depositInvoice(
        ctx,
        scheduled,
        result.customerId,
        result.projectId,
      )
    } else {
      // No schedule, so nothing has been agreed about when this is billed.
      // Billing the whole contract here is what this function used to do and is
      // the defect Phase 154 removed: it recognises a contract's revenue on
      // signing day. The honest answer is to raise nothing and say so.
      depositInvoiceId = null
    }
  }

  return { ...result, depositInvoiceId, sovStageCount, alreadyConverted: false }
}

/** The proposal's stages with the money worked out, or none if it has no schedule. */
async function scheduleForProposal(
  ctx: ActorContext,
  proposalId: string,
  contractCents: number,
): Promise<ScheduledStage[]> {
  const stages = await billingSchedule(ctx, proposalId)
  if (stages.length === 0) return []

  // Refused here as well as when the schedule was written, because a proposal
  // may have been edited into an impossible state by anything with database
  // access and this is the moment it turns into money.
  const verdict = scheduleStands(stages)
  if (!verdict.ok) throw new Refusal(verdict.why)

  return scheduleAmounts(contractCents, stages)
}

/**
 * Writes the earning stages onto the job as its schedule of values.
 *
 * The deposit is not among them, which is the one thing `sovStages` exists to
 * say: a schedule of values is what the job will earn, and a deposit is money
 * held before it earns anything. On the SOV it would make the contract value the
 * work plus money that is not work, so every WIP report would show the job
 * overbilled by the deposit from the day it was signed.
 */
async function scheduleOnJob(
  ctx: ActorContext,
  projectId: string,
  proposalId: string,
  scheduled: readonly ScheduledStage[],
): Promise<number> {
  const earning = sovStages(scheduled)
  if (earning.length === 0) return 0

  /**
   * A billing schedule must not require job costing.
   *
   * `setScheduleOfValues` calls `requireModule(ctx, 'job_costing')`, so without
   * this the whole conversion threw for any company that does not run that
   * module — and a plumber taking 50% up front and the rest on completion has a
   * perfectly ordinary schedule and no use for a construction schedule of
   * values. Found by running the test rather than by reading the call: the
   * schedule lives on the proposal, and the SOV is an additional projection of
   * it for companies that bill progressively.
   *
   * So the stages are kept either way and the job is told only when it can
   * listen. `sovStageCount` comes back zero, which is what the caller reports.
   */
  if (!(await moduleEnabled(ctx.companyId, 'job_costing'))) return 0

  const items = await db
    .select()
    .from(proposalItems)
    .where(scoped(ctx, proposalItems, eq(proposalItems.proposalId, proposalId)))
    .orderBy(proposalItems.sortOrder)

  // The revenue account the proposal's own lines named. Taking the first rather
  // than guessing: a schedule of values breaks the contract into stages of work,
  // not into the proposal's line items, so there is no per-stage account to
  // read and inventing one would be inventing an allocation.
  const revenueAccountId = items.find((item) => item.chartAccountId)?.chartAccountId
  if (!revenueAccountId) return 0

  await setScheduleOfValues(
    ctx,
    projectId,
    earning.map((stage, index) => ({
      itemNumber: String(index + 1).padStart(3, '0'),
      description: stage.label,
      scheduledValueCents: stage.amountCents,
      chartAccountId: revenueAccountId,
    })),
  )

  return earning.length
}

/**
 * Invoices the deposit, against unearned revenue rather than against revenue.
 *
 * `2500 Unearned Revenue` — or a dedicated retainers account when the company
 * has one — and `resolveRetainerAccount` is reused rather than reimplemented so
 * that a firm holding retainers and deposits puts both in the same place.
 * Phase 105 built that resolver to say *which* of the two it landed on, because
 * the reconciliation differs: on a dedicated account the subledger and the
 * ledger must be equal, and on the shared one only "not more than" can be
 * claimed. A deposit arriving in the shared case is exactly what that
 * distinction was written for.
 */
async function depositInvoice(
  ctx: ActorContext,
  scheduled: readonly ScheduledStage[],
  customerId: string,
  projectId: string,
): Promise<string | null> {
  const deposit = depositStage(scheduled)
  if (!deposit || deposit.amountCents <= 0) return null

  const { account } = await resolveRetainerAccount(ctx.companyId)

  const invoice = await createInvoice(ctx, {
    customerId,
    issueDate: new Date().toISOString().slice(0, 10),
    projectId,
    lines: [
      {
        chartAccountId: account.id,
        description: deposit.label,
        unitPriceCents: deposit.amountCents,
      },
    ],
  })

  return invoice.id
}

/** The proposal that closed the deal: the named one, or the won one. */
async function findWinningProposal(
  ctx: ActorContext,
  opportunityId: string,
  proposalId?: string,
) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(
      scoped(
        ctx,
        proposals,
        proposalId
          ? eq(proposals.id, proposalId)
          : and(eq(proposals.opportunityId, opportunityId), eq(proposals.status, 'won')),
      ),
    )
    .limit(1)

  return proposal ?? null
}

/**
 * `invoiceFromProposal` stood here until Phase 154, and what it did is the defect.
 *
 * It billed every selected item at `issueDate: today`, so a $500,000 contract
 * invoiced the client the whole contract value on the day they signed it. Its own
 * doc comment argued for the dimension it carried — *"a schedule that missed it
 * would show every converted job as underbilled by its own first invoice"* —
 * which was true about the dimension and silent about the amount.
 *
 * Deleted rather than left unreferenced: a function with no caller is a feature
 * that does not exist (Phase 49), and one that *would* be wrong if it were called
 * is worse than absent. What replaced it is `scheduleOnJob` and `depositInvoice`,
 * which between them raise at most the deposit and leave the rest on the job's
 * schedule of values to be billed as it is earned.
 */

/** Next sequential job code, e.g. JOB-1004. */
async function nextProjectCode(
  companyId: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(projects)
    .where(eq(projects.companyId, companyId))

  return `JOB-${1001 + Number(row?.count ?? 0)}`
}

export async function listProjects(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')

  return db
    .select({
      id: projects.id,
      code: projects.code,
      name: projects.name,
      status: projects.status,
      contractValueCents: projects.contractValueCents,
      organizationName: organizations.name,
      startDate: projects.startDate,
    })
    .from(projects)
    .leftJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(scoped(ctx, projects))
    .orderBy(projects.code)
}
