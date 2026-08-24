'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  createSegment,
  segmentSummary,
  unsuppressEmail,
  updateSegment,
} from '@/modules/marketing/audience'
import {
  addStep,
  cancelCampaign,
  createCampaign,
  sendStep,
} from '@/modules/marketing/campaigns'
import { completeTask } from '@/modules/marketing/analytics'
import { segmentDefinitionSchema } from '@/modules/marketing/segments'
import { createMarketingDocument, duplicateDocument } from '@/modules/design/documents'
import { reopenOpportunity } from '@/modules/crm/opportunities'
import type { Stage } from '@/modules/crm/pipeline'
import { messageFor } from '@/modules/errors'

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(
  path: string | string[],
  fn: () => Promise<string | void>,
): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const entry of Array.isArray(path) ? path : [path]) revalidatePath(entry)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Something went wrong.'),
    }
  }
}

// --- Segments --------------------------------------------------------------

const segmentInputSchema = z.object({
  name: z.string().trim().min(1, 'Name the segment.'),
  description: z.string().trim().optional(),
  definition: segmentDefinitionSchema,
})

export async function createSegmentAction(
  input: z.input<typeof segmentInputSchema>,
): Promise<ActionResult> {
  return run('/marketing/segments', async () => {
    const actor = await requireActor()
    const parsed = segmentInputSchema.parse(input)
    const segment = await createSegment(actor, parsed)
    return `Segment "${segment.name}" saved.`
  })
}

export async function updateSegmentAction(
  segmentId: string,
  input: z.input<typeof segmentInputSchema>,
): Promise<ActionResult> {
  return run('/marketing/segments', async () => {
    const actor = await requireActor()
    const parsed = segmentInputSchema.parse(input)
    await updateSegment(actor, segmentId, parsed)
    return 'Segment updated.'
  })
}

export type SegmentPreview = {
  total: number
  contactable: number
  noConsent: number
  suppressed: number
  noEmail: number
}

/**
 * Live counts for the segment builder.
 *
 * Returns the *reasons* people are excluded, not just how many are left. A
 * builder that shows "41 people" without saying that 160 more matched but
 * cannot be contacted invites a marketer to widen a segment that is already
 * as wide as consent allows.
 */
export async function previewSegmentAction(
  definition: unknown,
): Promise<{ ok: true; preview: SegmentPreview } | { ok: false; error: string }> {
  try {
    const actor = await requireActor()
    const parsed = segmentDefinitionSchema.parse(definition)
    return { ok: true, preview: await segmentSummary(actor, parsed) }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not evaluate that segment.'),
    }
  }
}

// --- Campaigns -------------------------------------------------------------

const campaignSchema = z.object({
  name: z.string().trim().min(1, 'Name the campaign.'),
  kind: z.enum(['broadcast', 'nurture']).optional(),
  segmentId: z.string().uuid().optional().or(z.literal('')),
  fromName: z.string().trim().optional(),
  fromEmail: z.string().trim().email('That is not a valid from address.').optional().or(z.literal('')),
  replyTo: z.string().trim().email().optional().or(z.literal('')),
  scheduledFor: z.string().trim().optional(),
  notes: z.string().trim().optional(),
})

export async function createCampaignAction(
  input: z.input<typeof campaignSchema>,
): Promise<ActionResult & { campaignId?: string }> {
  try {
    const actor = await requireActor()
    const parsed = campaignSchema.parse(input)

    const campaign = await createCampaign(actor, {
      name: parsed.name,
      kind: parsed.kind,
      segmentId: parsed.segmentId || null,
      fromName: parsed.fromName,
      fromEmail: parsed.fromEmail || undefined,
      replyTo: parsed.replyTo || null,
      scheduledFor: parsed.scheduledFor ? new Date(parsed.scheduledFor) : null,
      notes: parsed.notes,
    })

    revalidatePath('/marketing/campaigns')
    return { ok: true, campaignId: campaign.id, message: 'Campaign created.' }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not create the campaign.'),
    }
  }
}

const stepSchema = z.object({
  subject: z.string().trim().min(1, 'Give the email a subject.'),
  previewText: z.string().trim().optional(),
  delayDays: z.coerce.number().int().min(0).max(365).optional(),
  designDocumentId: z.string().uuid().optional().or(z.literal('')),
})

export async function addStepAction(
  campaignId: string,
  input: z.input<typeof stepSchema>,
): Promise<ActionResult> {
  return run(`/marketing/campaigns/${campaignId}`, async () => {
    const actor = await requireActor()
    const parsed = stepSchema.parse(input)
    const step = await addStep(actor, campaignId, {
      subject: parsed.subject,
      previewText: parsed.previewText,
      delayDays: parsed.delayDays,
      designDocumentId: parsed.designDocumentId || undefined,
    })
    return `Step ${step.stepNumber} added.`
  })
}

/**
 * Sends a step.
 *
 * The summary is reported back in full, including how many were skipped and
 * why — a send that reaches 40 of 200 people is not a failure, but a marketer
 * who is not told will assume it was one.
 */
export async function sendStepAction(
  campaignId: string,
  stepNumber: number,
): Promise<ActionResult> {
  return run(['/marketing', `/marketing/campaigns/${campaignId}`], async () => {
    const actor = await requireActor()
    const summary = await sendStep(actor, campaignId, stepNumber)

    const parts = [`${summary.sent} sent`]
    if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`)
    if (summary.failed > 0) parts.push(`${summary.failed} failed`)

    return `${summary.matched} matched — ${parts.join(', ')}.`
  })
}

export async function cancelCampaignAction(campaignId: string): Promise<ActionResult> {
  return run(['/marketing/campaigns', `/marketing/campaigns/${campaignId}`], async () => {
    const actor = await requireActor()
    await cancelCampaign(actor, campaignId)
    return 'Campaign cancelled.'
  })
}

// --- Creative --------------------------------------------------------------

export async function createCreativeAction(
  name: string,
  templateKey?: string,
): Promise<ActionResult & { documentId?: string }> {
  try {
    const actor = await requireActor()
    const document = await createMarketingDocument(actor, {
      name: name.trim() || 'Untitled creative',
      templateKey: templateKey || undefined,
    })
    revalidatePath('/marketing/creative')
    return { ok: true, documentId: document.id }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not create the creative.'),
    }
  }
}

export async function duplicateCreativeAction(
  documentId: string,
  name?: string,
): Promise<ActionResult & { documentId?: string }> {
  try {
    const actor = await requireActor()
    const copy = await duplicateDocument(actor, documentId, name)
    revalidatePath('/marketing/creative')
    return { ok: true, documentId: copy.id, message: `Copied to "${copy.name}".` }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not copy that creative.'),
    }
  }
}

// --- Suppressions and the sales loop ---------------------------------------

export async function unsuppressAction(email: string): Promise<ActionResult> {
  return run('/marketing/suppressions', async () => {
    const actor = await requireActor()
    await unsuppressEmail(actor, email)
    return `${email} may be contacted again once they opt back in.`
  })
}

export async function completeTaskAction(taskId: string): Promise<ActionResult> {
  return run('/marketing', async () => {
    const actor = await requireActor()
    await completeTask(actor, taskId)
    return 'Task closed.'
  })
}

/**
 * Reopens a lost deal from the nurture dashboard (spec §10).
 *
 * The marketing-to-sales handoff, and always a person's decision — engagement
 * raises a task, it never reopens a deal on its own.
 */
export async function reopenFromMarketingAction(
  opportunityId: string,
  stage: Stage = 'qualified',
): Promise<ActionResult> {
  return run(['/marketing', '/crm'], async () => {
    const actor = await requireActor()
    await reopenOpportunity(actor, opportunityId, stage)
    return 'Deal reopened in the pipeline.'
  })
}
