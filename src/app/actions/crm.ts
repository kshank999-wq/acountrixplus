'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { parseAmountToCents } from '@/lib/money'
import {
  changeStage,
  createContact,
  createOpportunity,
  createOrganization,
  organizationById,
  updateOrganization,
  reopenOpportunity,
  updateOpportunity,
} from '@/modules/crm/opportunities'
import {
  createProposal,
  decideProposal,
  sendProposal,
  updateProposalItems,
} from '@/modules/crm/proposals'
import { convertWonOpportunity } from '@/modules/crm/conversion'
import {
  ORGANIZATION_FIELDS,
  describeChanges,
  diffParty,
} from '@/modules/parties/changes'
import { createIntakeKey, revokeIntakeKey } from '@/modules/crm/intake'
import type { Stage } from '@/modules/crm/pipeline'
import { messageFor } from '@/modules/errors'

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(path: string, fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Something went wrong.'),
    }
  }
}

// --- Organizations and opportunities ---------------------------------------

const organizationSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().optional(),
  website: z.string().trim().optional(),
  industry: z.string().trim().optional(),
  // The whole address, since Phase 78. `organizations` has had all six columns
  // since Phase 3 and this schema offered one of them.
  addressLine1: z.string().trim().optional(),
  addressLine2: z.string().trim().optional(),
  city: z.string().trim().optional(),
  region: z.string().trim().optional(),
  postalCode: z.string().trim().optional(),
  country: z.string().trim().optional(),
  source: z.string().trim().optional(),
  isStrategicAccount: z.boolean().optional(),
})

export async function createOrganizationAction(
  input: z.input<typeof organizationSchema>,
): Promise<ActionResult> {
  return run('/crm/organizations', async () => {
    const actor = await requireActor()
    const parsed = organizationSchema.parse(input)
    const organization = await createOrganization(actor, {
      ...parsed,
      email: parsed.email || undefined,
    })
    return `Added ${organization.name}.`
  })
}

/**
 * Corrects a client (Phase 78).
 *
 * The organisation record had no update path at all until now — see
 * `updateOrganization`. The notice names the fields that changed rather than
 * counting them, which is Phase 45's `describeChanges` doing the same job it
 * does for a customer.
 */
export async function updateOrganizationAction(
  organizationId: string,
  input: z.input<typeof organizationSchema>,
): Promise<ActionResult> {
  return run('/crm/organizations', async () => {
    const actor = await requireActor()
    const parsed = organizationSchema.parse(input)

    const fields = { ...parsed, email: parsed.email || null }

    const before = await organizationById(actor, organizationId)
    const changes = diffParty({ fields: ORGANIZATION_FIELDS, before, after: fields })

    await updateOrganization(actor, organizationId, fields)

    return describeChanges(changes)
  })
}

const opportunitySchema = z.object({
  organizationId: z.string().uuid(),
  title: z.string().trim().min(1, 'A title is required.'),
  expectedValue: z.string().optional(),
  source: z.string().trim().optional(),
  expectedCloseDate: z.string().optional(),
})

export async function createOpportunityAction(
  input: z.input<typeof opportunitySchema>,
): Promise<ActionResult> {
  return run('/crm', async () => {
    const actor = await requireActor()
    const parsed = opportunitySchema.parse(input)

    await createOpportunity(actor, {
      organizationId: parsed.organizationId,
      title: parsed.title,
      expectedValueCents: parsed.expectedValue?.trim()
        ? parseAmountToCents(parsed.expectedValue)
        : 0,
      source: parsed.source || null,
      expectedCloseDate: parsed.expectedCloseDate || null,
    })

    return 'Opportunity added to the pipeline.'
  })
}

export async function changeStageAction(
  opportunityId: string,
  stage: Stage,
  lossReason?: string,
  lossNotes?: string,
): Promise<ActionResult> {
  return run('/crm', async () => {
    const actor = await requireActor()
    await changeStage(actor, opportunityId, {
      stage,
      lossReason: lossReason as never,
      lossNotes,
    })
    return 'Stage updated.'
  })
}

export async function reopenOpportunityAction(
  opportunityId: string,
  stage: Stage,
): Promise<ActionResult> {
  return run('/crm', async () => {
    const actor = await requireActor()
    await reopenOpportunity(actor, opportunityId, stage)
    return 'Opportunity reopened.'
  })
}

export async function updateOpportunityAction(
  opportunityId: string,
  input: { expectedValue?: string; probability?: number; notes?: string },
): Promise<ActionResult> {
  return run('/crm', async () => {
    const actor = await requireActor()
    await updateOpportunity(actor, opportunityId, {
      expectedValueCents: input.expectedValue?.trim()
        ? parseAmountToCents(input.expectedValue)
        : undefined,
      probability: input.probability,
      notes: input.notes,
    })
    return 'Opportunity updated.'
  })
}

export async function addContactAction(
  organizationId: string,
  input: { firstName?: string; lastName?: string; email?: string; marketingConsent?: boolean },
): Promise<ActionResult> {
  return run('/crm/organizations', async () => {
    const actor = await requireActor()
    await createContact(actor, {
      organizationId,
      ...input,
      // Consent is only ever recorded from an explicit choice.
      emailConsent: input.marketingConsent ? 'subscribed' : 'unknown',
      consentSource: input.marketingConsent ? 'manual_entry' : undefined,
    })
    return 'Contact added.'
  })
}

// --- Proposals -------------------------------------------------------------

const proposalSchema = z.object({
  opportunityId: z.string().uuid(),
  title: z.string().trim().min(1),
  expiresOn: z.string().optional(),
  executiveSummary: z.string().optional(),
  scope: z.string().optional(),
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1),
        quantity: z.string(),
        unitPrice: z.string(),
        isOptional: z.boolean().optional(),
        chartAccountId: z.string().uuid().optional(),
      }),
    )
    .min(1),
})

export async function createProposalAction(
  input: z.input<typeof proposalSchema>,
): Promise<ActionResult> {
  return run('/crm/proposals', async () => {
    const actor = await requireActor()
    const parsed = proposalSchema.parse(input)

    const proposal = await createProposal(actor, {
      opportunityId: parsed.opportunityId,
      title: parsed.title,
      expiresOn: parsed.expiresOn || undefined,
      executiveSummary: parsed.executiveSummary,
      scope: parsed.scope,
      items: parsed.items.map((item) => ({
        description: item.description,
        // Quantity is entered in whole or fractional units, stored as thousandths.
        quantityMilli: Math.round((Number(item.quantity) || 1) * 1000),
        unitPriceCents: parseAmountToCents(item.unitPrice),
        isOptional: item.isOptional ?? false,
        chartAccountId: item.chartAccountId ?? null,
      })),
    })

    return `Drafted ${proposal.number}.`
  })
}

export async function sendProposalAction(proposalId: string): Promise<ActionResult> {
  return run('/crm/proposals', async () => {
    const actor = await requireActor()
    const { versionNumber } = await sendProposal(actor, proposalId)
    return `Sent as version ${versionNumber}. The client link is now live.`
  })
}

export async function decideProposalAction(
  proposalId: string,
  status: 'won' | 'lost' | 'expired' | 'no_decision',
): Promise<ActionResult> {
  return run('/crm/proposals', async () => {
    const actor = await requireActor()
    await decideProposal(actor, proposalId, status)
    return `Marked ${status.replace('_', ' ')}.`
  })
}

export async function updateProposalItemsAction(
  proposalId: string,
  items: Array<{
    description: string
    quantity: string
    unitPrice: string
    isOptional?: boolean
    chartAccountId?: string
  }>,
): Promise<ActionResult> {
  return run('/crm/proposals', async () => {
    const actor = await requireActor()
    await updateProposalItems(
      actor,
      proposalId,
      items.map((item) => ({
        description: item.description,
        quantityMilli: Math.round((Number(item.quantity) || 1) * 1000),
        unitPriceCents: parseAmountToCents(item.unitPrice),
        isOptional: item.isOptional ?? false,
        chartAccountId: item.chartAccountId ?? null,
      })),
    )
    return 'Proposal updated.'
  })
}

// --- Conversion ------------------------------------------------------------

export async function convertAction(
  opportunityId: string,
  createInvoice: boolean,
): Promise<ActionResult> {
  return run('/crm', async () => {
    const actor = await requireActor()
    const result = await convertWonOpportunity(actor, opportunityId, { createInvoice })

    if (result.alreadyConverted) return 'This opportunity was already converted.'
    return result.invoiceId
      ? 'Created the client, the job, and a draft invoice.'
      : 'Created the client and the job.'
  })
}

// --- Lead intake keys ------------------------------------------------------

export async function createIntakeKeyAction(
  name: string,
  allowedOrigins: string,
  hourlyLimit: number,
): Promise<ActionResult> {
  return run('/crm/intake', async () => {
    const actor = await requireActor()
    await createIntakeKey(actor, {
      name,
      allowedOrigins: allowedOrigins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      hourlyLimit,
    })
    return 'Intake key created.'
  })
}

export async function revokeIntakeKeyAction(keyId: string): Promise<ActionResult> {
  return run('/crm/intake', async () => {
    const actor = await requireActor()
    await revokeIntakeKey(actor, keyId)
    return 'Key revoked. Forms using it will stop being accepted.'
  })
}
