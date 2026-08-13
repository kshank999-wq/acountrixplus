import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import {
  memberships,
  opportunities,
  opportunityActivities,
  proposalAcceptances,
  proposalItems,
  proposalVersions,
  proposals,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { hasPermission, type Role } from '@/modules/permissions'
import { notifyProposalDecided } from '@/modules/mobile/notifications'
import { OPEN_STAGES } from './pipeline'
import { computeTotals } from './proposals'

/**
 * Proposal acceptance and e-signature (spec §7).
 *
 * The second unauthenticated write path in the system, and it carries more
 * weight than the first: this one closes a deal. It follows the same posture
 * as lead intake — validate hard, cap everything, log the request metadata,
 * and reveal nothing an anonymous caller should not know.
 *
 * The rule that matters most: **the accepted total is recomputed on the
 * server** from the items the client selected. A total submitted by the
 * browser is never trusted, because it is the number the company will invoice
 * against.
 */

export const acceptanceSchema = z.object({
  signerName: z.string().trim().min(1).max(200),
  signerEmail: z.string().trim().email().max(320).optional().or(z.literal('')),
  signerTitle: z.string().trim().max(200).optional(),
  /** The typed signature. Must match the signer's name, checked below. */
  signatureText: z.string().trim().min(1).max(200),
  /** Ids of optional items the client chose to include. */
  selectedItemIds: z.array(z.string().uuid()).max(100).default([]),
  agreed: z.literal(true),
})

export type AcceptanceInput = z.infer<typeof acceptanceSchema>

export type AcceptanceResult =
  | { ok: true; acceptedTotalCents: number }
  | { ok: false; status: number; reason: string; message: string }

export type AcceptanceMeta = { ipPrefix?: string | null; userAgent?: string | null }

/** Statuses a proposal can be accepted from. */
const ACCEPTABLE_STATUSES = new Set(['sent', 'viewed'])

/**
 * Records a client's acceptance against a public proposal token.
 *
 * Returns a discriminated result rather than throwing, because the caller is
 * an HTTP route serving an anonymous client.
 */
export async function acceptProposal(
  publicToken: string,
  payload: unknown,
  meta: AcceptanceMeta = {},
): Promise<AcceptanceResult> {
  const parsed = acceptanceSchema.safeParse(payload)
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      reason: 'invalid',
      message: 'Please complete every field and confirm you agree.',
    }
  }
  const input = parsed.data

  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!proposal) {
    return { ok: false, status: 404, reason: 'not_found', message: 'Proposal not found.' }
  }

  // A typed signature is only meaningful if it is the signer's own name.
  if (
    input.signatureText.trim().toLowerCase() !== input.signerName.trim().toLowerCase()
  ) {
    return {
      ok: false,
      status: 400,
      reason: 'signature_mismatch',
      message: 'The signature must match the name entered above.',
    }
  }

  if (!ACCEPTABLE_STATUSES.has(proposal.status)) {
    const message =
      proposal.status === 'won'
        ? 'This proposal has already been accepted.'
        : 'This proposal is no longer open for acceptance.'
    return { ok: false, status: 409, reason: 'not_acceptable', message }
  }

  if (proposal.expiresOn && proposal.expiresOn < today()) {
    return {
      ok: false,
      status: 409,
      reason: 'expired',
      message: 'This proposal has expired. Please ask for an updated copy.',
    }
  }

  const items = await db
    .select()
    .from(proposalItems)
    .where(eq(proposalItems.proposalId, proposal.id))

  // Recomputed server-side from the client's selection. The browser's idea of
  // the total is never used.
  const selected = new Set(input.selectedItemIds)
  const effective = items.map((item) => ({
    amountCents: item.amountCents,
    isOptional: item.isOptional,
    isSelected: item.isOptional ? selected.has(item.id) : true,
  }))

  const totals = computeTotals(effective, {
    discountCents: proposal.discountCents,
    taxCents: proposal.taxCents,
  })

  // Only ids that belong to this proposal, and only optional ones, are stored.
  const optionalIds = new Set(items.filter((item) => item.isOptional).map((item) => item.id))
  const acceptedSelections = input.selectedItemIds.filter((id) => optionalIds.has(id))

  const [latestVersion] = await db
    .select({ id: proposalVersions.id })
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposal.id))
    .orderBy(desc(proposalVersions.versionNumber))
    .limit(1)

  try {
    await db.transaction(async (tx) => {
      await tx.insert(proposalAcceptances).values({
        companyId: proposal.companyId,
        proposalId: proposal.id,
        proposalVersionId: latestVersion?.id ?? null,
        signerName: input.signerName,
        signerEmail: input.signerEmail || null,
        signerTitle: input.signerTitle ?? null,
        signatureText: input.signatureText,
        selectedItemIds: acceptedSelections,
        acceptedTotalCents: totals.totalCents,
        ipPrefix: meta.ipPrefix ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      })

      // The selection the client made becomes the proposal's own state, so the
      // figures the company sees match what was signed.
      for (const item of items) {
        if (!item.isOptional) continue
        await tx
          .update(proposalItems)
          .set({ isSelected: selected.has(item.id) })
          .where(eq(proposalItems.id, item.id))
      }

      await tx
        .update(proposals)
        .set({
          status: 'won',
          subtotalCents: totals.subtotalCents,
          totalCents: totals.totalCents,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, proposal.id))

      // Close the deal from wherever it currently sits in the pipeline — a
      // proposal can be accepted while the opportunity is in negotiation or
      // follow-up, not only straight after it was sent. Restricting to open
      // stages keeps this forward-only: it will never reopen a deal that has
      // already been closed some other way.
      await tx
        .update(opportunities)
        .set({
          stage: 'won',
          probability: 100,
          closedAt: new Date(),
          expectedValueCents: totals.totalCents,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(opportunities.id, proposal.opportunityId),
            eq(opportunities.companyId, proposal.companyId),
            inArray(opportunities.stage, OPEN_STAGES),
          ),
        )

      await tx.insert(opportunityActivities).values({
        companyId: proposal.companyId,
        opportunityId: proposal.opportunityId,
        kind: 'proposal_accepted',
        summary: `${input.signerName} accepted proposal ${proposal.number}`,
        detail: {
          acceptedTotalCents: totals.totalCents,
          selectedOptionalItems: acceptedSelections.length,
        },
        actorName: input.signerName,
      })
    })
  } catch (error) {
    // The unique constraint on proposalId is what makes double-acceptance
    // impossible under concurrency, rather than the status check above.
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        reason: 'already_accepted',
        message: 'This proposal has already been accepted.',
      }
    }
    throw error
  }

  // Told after the acceptance is committed, and never inside its transaction:
  // a push service having a bad minute must not roll back a signature the
  // client has already given (Phase 8).
  await announceAcceptance(proposal, input.signerName).catch(() => {})

  return { ok: true, acceptedTotalCents: totals.totalCents }
}

/**
 * Notifies the company that a client signed.
 *
 * This is the event the mobile app exists for: it happens when nobody is
 * looking at a screen, and it is the one people actually want to be
 * interrupted about. Everyone who can manage proposals is told, because a
 * signature is not one person's business.
 *
 * Failures are swallowed by the caller. A notification is a courtesy; the
 * acceptance is the record.
 */
async function announceAcceptance(
  proposal: { id: string; companyId: string; number: string },
  signerName: string,
): Promise<void> {
  const recipients = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.companyId, proposal.companyId), eq(memberships.isActive, true)))

  for (const recipient of recipients) {
    if (!hasPermission(recipient.role as Role, 'proposals:manage')) continue

    await notifyProposalDecided({
      companyId: proposal.companyId,
      userId: recipient.userId,
      proposalNumber: proposal.number,
      clientName: signerName,
      won: true,
    })
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  )
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The acceptance record for a proposal, for the internal view. */
export async function acceptanceFor(ctx: ActorContext, proposalId: string) {
  requirePermission(ctx, 'proposals:view')

  const [acceptance] = await db
    .select()
    .from(proposalAcceptances)
    .where(scoped(ctx, proposalAcceptances, eq(proposalAcceptances.proposalId, proposalId)))
    .limit(1)

  return acceptance ?? null
}

/** Whether a proposal is currently open for a client to accept. */
export function isAcceptable(proposal: {
  status: string
  expiresOn: string | null
}): boolean {
  if (!ACCEPTABLE_STATUSES.has(proposal.status)) return false
  if (proposal.expiresOn && proposal.expiresOn < today()) return false
  return true
}
