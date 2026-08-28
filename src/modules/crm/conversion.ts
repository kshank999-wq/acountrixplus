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
  invoiceId: string | null
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

  if (!row) throw new Error('Opportunity not found')
  const { opportunity, organization } = row

  if (opportunity.stage !== 'won') {
    throw new Error('Only a won opportunity can be converted to a client and job.')
  }

  // Idempotent: converting twice must not create a second client or job.
  if (opportunity.convertedCustomerId && opportunity.convertedProjectId) {
    return {
      customerId: opportunity.convertedCustomerId,
      projectId: opportunity.convertedProjectId,
      invoiceId: null,
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

  // Invoicing is a separate transaction because it posts to the ledger and can
  // fail on its own terms — a closed period, a missing revenue account. The
  // client and job are already correctly created either way.
  let invoiceId: string | null = null
  if (opts.createInvoice && winningProposal) {
    invoiceId = await invoiceFromProposal(
      ctx,
      winningProposal.id,
      result.customerId,
      result.projectId,
    )
  }

  return { ...result, invoiceId, alreadyConverted: false }
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
 * Raises an invoice from the winning proposal's line items (spec §6).
 *
 * Only selected items are billed, matching what the proposal totalled.
 * Items without a revenue account are skipped rather than guessed at — the
 * caller gets no invoice instead of a wrong one.
 *
 * The invoice carries the new job as its dimension, which is what keeps the
 * WIP schedule honest: revenue billed the moment a proposal is won is billed
 * *on that job*, and a schedule that missed it would show every converted job
 * as underbilled by its own first invoice.
 */
async function invoiceFromProposal(
  ctx: ActorContext,
  proposalId: string,
  customerId: string,
  projectId: string,
): Promise<string | null> {
  const items = await db
    .select()
    .from(proposalItems)
    .where(scoped(ctx, proposalItems, eq(proposalItems.proposalId, proposalId)))
    .orderBy(proposalItems.sortOrder)

  const billable = items.filter(
    (item) => (!item.isOptional || item.isSelected) && item.chartAccountId,
  )

  if (billable.length === 0) return null

  const invoice = await createInvoice(ctx, {
    customerId,
    issueDate: new Date().toISOString().slice(0, 10),
    // Tagged with the job it came from (Phase 7), so revenue billed at
    // conversion appears in the job's WIP rather than going missing from it.
    projectId,
    lines: billable.map((item) => ({
      chartAccountId: item.chartAccountId!,
      description: item.description,
      quantityMilli: item.quantityMilli,
      unitPriceCents: item.unitPriceCents,
    })),
  })

  return invoice.id
}

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
