import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  campaignEvents,
  campaignRecipients,
  campaignSteps,
  campaigns,
  companies,
  companyProfiles,
  contacts,
  designDocuments,
  segments,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { letterheadFor } from '@/modules/brand/letterhead'
import { senderName } from '@/modules/brand/voice'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { parseBlocks } from '@/modules/design/blocks'
import { buildMergeContext, resolveBlocks } from '@/modules/design/merge-fields'
import { trackedLink } from './click-links'
import { emailBrand, renderEmailHtml, renderEmailText, type EmailBrand } from './render-email'
import { defaultBrandKit } from '@/modules/studio/service'
import { evaluateSegment, parseDefinition, suppressedEmails } from './audience'
import { getEmailProvider, publicBaseUrl, type OutboundMessage } from './email-provider'

/**
 * Campaigns and the send pipeline (spec §10).
 *
 * The rule this module exists to enforce: **consent is checked at send time.**
 * A segment describes who you are interested in; permission to contact them is
 * decided as late as possible, against the state of the world at the moment
 * the message would go out.
 */

export type CampaignInput = {
  name: string
  kind?: 'broadcast' | 'nurture'
  segmentId?: string | null
  fromName?: string
  fromEmail?: string
  replyTo?: string | null
  scheduledFor?: Date | null
  notes?: string
}

export async function createCampaign(ctx: ActorContext, input: CampaignInput) {
  requirePermission(ctx, 'marketing:manage')

  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        companyId: ctx.companyId,
        name: input.name,
        kind: input.kind ?? 'broadcast',
        segmentId: input.segmentId ?? null,
        fromName: input.fromName ?? null,
        fromEmail: input.fromEmail ?? null,
        replyTo: input.replyTo ?? null,
        scheduledFor: input.scheduledFor ?? null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'campaign.create',
        entityType: 'campaign',
        entityId: campaign.id,
        after: { name: campaign.name, kind: campaign.kind },
      },
      tx,
    )

    return campaign
  })
}

export async function addStep(
  ctx: ActorContext,
  campaignId: string,
  input: { subject: string; previewText?: string; delayDays?: number; designDocumentId?: string },
) {
  requirePermission(ctx, 'marketing:manage')

  const campaign = await loadCampaign(ctx, campaignId)
  if (campaign.status !== 'draft') {
    throw new Error('Only a draft campaign can be changed.')
  }

  return db.transaction(async (tx) => {
    const [{ nextStep }] = await tx
      .select({ nextStep: sql<number>`coalesce(max(${campaignSteps.stepNumber}), 0) + 1` })
      .from(campaignSteps)
      .where(eq(campaignSteps.campaignId, campaignId))

    const [step] = await tx
      .insert(campaignSteps)
      .values({
        companyId: ctx.companyId,
        campaignId,
        stepNumber: nextStep,
        delayDays: input.delayDays ?? 0,
        subject: input.subject,
        previewText: input.previewText ?? null,
        designDocumentId: input.designDocumentId ?? null,
      })
      .returning()

    return step
  })
}

export type SendSummary = {
  campaignId: string
  stepNumber: number
  matched: number
  sent: number
  skipped: number
  failed: number
  skipReasons: Record<string, number>
}

/**
 * Sends one step of a campaign (spec §10).
 *
 * The order here is the whole point:
 *
 *  1. Evaluate the segment — who are we interested in?
 *  2. Re-check consent and the suppression list *now*, not when the campaign
 *     was built.
 *  3. Record a recipient row for everyone, including those skipped and why —
 *     so a marketer can see that 200 matched and 40 were emailed.
 *  4. Only then hand anything to the provider.
 */
export async function sendStep(
  ctx: ActorContext,
  campaignId: string,
  stepNumber = 1,
): Promise<SendSummary> {
  requirePermission(ctx, 'marketing:manage')

  const campaign = await loadCampaign(ctx, campaignId)
  if (campaign.status === 'sent' || campaign.status === 'cancelled') {
    throw new Error(`This campaign is ${campaign.status} and cannot be sent again.`)
  }
  if (!campaign.segmentId) {
    throw new Error('Choose an audience segment before sending.')
  }
  if (!campaign.fromEmail) {
    throw new Error('Set a from address before sending.')
  }

  const [step] = await db
    .select()
    .from(campaignSteps)
    .where(
      and(
        eq(campaignSteps.campaignId, campaignId),
        eq(campaignSteps.stepNumber, stepNumber),
        eq(campaignSteps.companyId, ctx.companyId),
      ),
    )
    .limit(1)

  if (!step) throw new Error(`Step ${stepNumber} does not exist on this campaign.`)

  const [segment] = await db
    .select()
    .from(segments)
    .where(scoped(ctx, segments, eq(segments.id, campaign.segmentId)))
    .limit(1)

  if (!segment) throw new Error('The campaign audience no longer exists.')

  // Step 1 and 2: who matches, and who may actually be contacted right now.
  const audience = await evaluateSegment(ctx, parseDefinition(segment.definition))
  const suppressed = await suppressedEmails(ctx.companyId)

  const creative = step.designDocumentId
    ? await loadCreative(ctx.companyId, step.designDocumentId)
    : null

  const [profile] = await db
    .select()
    .from(companyProfiles)
    .where(eq(companyProfiles.companyId, ctx.companyId))
    .limit(1)

  /*
    The company's own brand kit (Phase 80).

    `renderEmailHtml` has taken a `brand` since Phase 5 and **nothing has ever
    passed one**, so every campaign this application has sent went out in the
    default colours while the company's chosen ones sat in the Design Center
    styling its proposals. Phase 74 stopped a company's marketing going out
    under our name; this stops it going out in our colours.

    Loaded once per run rather than per recipient — a send to four thousand
    contacts is one row read, not four thousand.
  */
  const kit = await defaultBrandKit(ctx.companyId)

  // The company's own name, which this module never loaded (Phase 74). The
  // profile is optional and its legal name is nullable; `companies.name` is
  // NOT NULL and exists from the moment a tenant registers, so it is the end
  // of the chain that stops a company's marketing going out under ours.
  const [company] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1)

  if (!company) throw new Error('This company no longer exists.')

  const provider = getEmailProvider()
  const baseUrl = publicBaseUrl()

  const summary: SendSummary = {
    campaignId,
    stepNumber,
    matched: audience.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    skipReasons: {},
  }

  await db
    .update(campaigns)
    .set({ status: 'sending', startedAt: campaign.startedAt ?? new Date(), updatedAt: new Date() })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.companyId, ctx.companyId)))

  for (const member of audience) {
    const email = member.email?.trim().toLowerCase() ?? ''

    // Step 2, again and definitively: the last word before anything is sent.
    const blocked =
      !member.contactable ||
      !email ||
      suppressed.has(email)
        ? (member.reason ?? (suppressed.has(email) ? 'suppressed' : 'no_email'))
        : null

    const token = randomBytes(24).toString('base64url')

    const [recipient] = await db
      .insert(campaignRecipients)
      .values({
        companyId: ctx.companyId,
        campaignId,
        stepId: step.id,
        contactId: member.contactId,
        organizationId: member.organizationId,
        email: email || 'unknown',
        status: blocked ? 'skipped' : 'pending',
        skipReason: blocked,
        unsubscribeToken: token,
      })
      // A contact already recorded for this step is not sent to twice.
      .onConflictDoNothing({
        target: [campaignRecipients.stepId, campaignRecipients.contactId],
      })
      .returning()

    if (!recipient) continue

    if (blocked) {
      summary.skipped++
      summary.skipReasons[blocked] = (summary.skipReasons[blocked] ?? 0) + 1
      continue
    }

    // Step 4: only now does a provider see anything.
    const message = await buildMessage({
      recipient,
      campaign,
      step,
      creative,
      profile,
      brand: emailBrand(kit),
      companyName: company.name,
      baseUrl,
      contactName: await contactDisplayName(member.contactId),
      organizationName: member.organizationName,
    })

    const result = await provider.send(message)

    if (result.ok) {
      await db
        .update(campaignRecipients)
        .set({
          status: 'sent',
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
        })
        .where(eq(campaignRecipients.id, recipient.id))

      await db.insert(campaignEvents).values({
        companyId: ctx.companyId,
        recipientId: recipient.id,
        kind: 'sent',
      })

      summary.sent++
    } else {
      await db
        .update(campaignRecipients)
        .set({ status: 'bounced', skipReason: result.error })
        .where(eq(campaignRecipients.id, recipient.id))

      await db.insert(campaignEvents).values({
        companyId: ctx.companyId,
        recipientId: recipient.id,
        kind: 'bounce',
      })

      summary.failed++
    }
  }

  const remaining = await db
    .select({ total: sql<string>`count(*)` })
    .from(campaignSteps)
    .where(
      and(
        eq(campaignSteps.campaignId, campaignId),
        sql`${campaignSteps.stepNumber} > ${stepNumber}`,
      ),
    )

  const isLastStep = Number(remaining[0]?.total ?? 0) === 0

  await db
    .update(campaigns)
    .set({
      status: isLastStep ? 'sent' : 'sending',
      completedAt: isLastStep ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.companyId, ctx.companyId)))

  await recordAudit(ctx, {
    action: 'campaign.send',
    entityType: 'campaign',
    entityId: campaignId,
    after: {
      stepNumber,
      matched: summary.matched,
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failed,
    },
  })

  return summary
}

/** The creative for a step, resolved to blocks. */
async function loadCreative(companyId: string, documentId: string) {
  const [document] = await db
    .select()
    .from(designDocuments)
    .where(
      and(eq(designDocuments.id, documentId), eq(designDocuments.companyId, companyId)),
    )
    .limit(1)

  return document ?? null
}

async function contactDisplayName(contactId: string): Promise<string | null> {
  const [contact] = await db
    .select({ firstName: contacts.firstName, lastName: contacts.lastName })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)

  if (!contact) return null
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null
}

/** Assembles the outbound message, resolving merge fields per recipient. */
async function buildMessage(input: {
  recipient: typeof campaignRecipients.$inferSelect
  campaign: typeof campaigns.$inferSelect
  step: typeof campaignSteps.$inferSelect
  creative: typeof designDocuments.$inferSelect | null
  profile: typeof companyProfiles.$inferSelect | undefined
  /** The company's own colours, or the default when it has no kit (Phase 80). */
  brand: EmailBrand
  /** `companies.name`. Not null, and the reason a letter cannot fall through. */
  companyName: string
  baseUrl: string
  contactName: string | null
  organizationName: string | null
}): Promise<OutboundMessage> {
  const { recipient, campaign, step, creative, profile, brand, companyName, baseUrl } = input

  // The letterhead, since Phase 76 — the same object the invoice prints its
  // masthead from, so `{{company.address}}` in a campaign and the address on
  // that company's invoice cannot disagree. Its `name` is `senderName`'s, which
  // is also the `From:` line below.
  const head = letterheadFor({ companyName, profile })

  const context = buildMergeContext({
    company: head,
    client: {
      name: input.organizationName,
      contactName: input.contactName,
      email: recipient.email,
    },
  })

  const blocks = creative ? resolveBlocks(parseBlocks(creative.blocks), context) : []

  const unsubscribeUrl = `${baseUrl}/u/${recipient.unsubscribeToken}`
  const trackUrl = `${baseUrl}/api/track/${recipient.unsubscribeToken}`

  // Every author link goes through the click recorder, which redirects to the
  // original. The unsubscribe link deliberately does not — a person leaving
  // should not have their departure counted as engagement.
  const trackLink = (url: string) => (url.startsWith('#') ? url : trackedLink(trackUrl, url))

  return {
    to: recipient.email,
    // Theirs, never ours (Phase 74). This is a company's own marketing, going
    // to its own contacts, over its own unsubscribe link.
    fromName: senderName({ chosen: campaign.fromName, legalName: profile?.legalName, companyName }),
    fromEmail: campaign.fromEmail!,
    replyTo: campaign.replyTo,
    subject: resolveSubject(step.subject, context),
    html: renderEmailHtml({
      blocks,
      brand,
      previewText: step.previewText,
      unsubscribeUrl,
      trackUrl,
      trackLink,
      footer: profile?.documentFooter ?? null,
    }),
    text: renderEmailText({ blocks, unsubscribeUrl, trackLink }),
    unsubscribeUrl,
    unsubscribePostUrl: `${baseUrl}/api/unsubscribe/${recipient.unsubscribeToken}`,
    tags: { recipientId: recipient.id, campaignId: campaign.id },
  }
}

function resolveSubject(subject: string, context: Record<string, string>): string {
  return subject.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => context[key] ?? '')
}

async function loadCampaign(ctx: ActorContext, campaignId: string) {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(scoped(ctx, campaigns, eq(campaigns.id, campaignId)))
    .limit(1)

  if (!campaign) throw new Error('Campaign not found')
  return campaign
}

export async function getCampaign(ctx: ActorContext, campaignId: string) {
  requirePermission(ctx, 'marketing:view')

  const campaign = await loadCampaign(ctx, campaignId)
  const steps = await db
    .select()
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, campaignId))
    .orderBy(asc(campaignSteps.stepNumber))

  return { campaign, steps }
}

export async function listCampaigns(ctx: ActorContext) {
  requirePermission(ctx, 'marketing:view')

  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      kind: campaigns.kind,
      status: campaigns.status,
      scheduledFor: campaigns.scheduledFor,
      completedAt: campaigns.completedAt,
      segmentName: segments.name,
    })
    .from(campaigns)
    .leftJoin(segments, eq(segments.id, campaigns.segmentId))
    .where(scoped(ctx, campaigns))
    .orderBy(desc(campaigns.createdAt))
}

/** Recipients of a campaign, for the delivery detail view. */
export async function campaignRecipientRows(ctx: ActorContext, campaignId: string) {
  requirePermission(ctx, 'marketing:view')

  return db
    .select()
    .from(campaignRecipients)
    .where(scoped(ctx, campaignRecipients, eq(campaignRecipients.campaignId, campaignId)))
    .orderBy(desc(campaignRecipients.createdAt))
    .limit(500)
}

/** Cancels a campaign so it cannot be sent. */
export async function cancelCampaign(ctx: ActorContext, campaignId: string) {
  requirePermission(ctx, 'marketing:manage')

  await db.transaction(async (tx) => {
    const [cancelled] = await tx
      .update(campaigns)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.companyId, ctx.companyId),
          inArray(campaigns.status, ['draft', 'scheduled', 'paused']),
        ),
      )
      .returning({ id: campaigns.id })

    // A campaign already sent or cancelled is left alone, and so is the log.
    if (!cancelled) return

    await recordAudit(
      ctx,
      { action: 'campaign.cancel', entityType: 'campaign', entityId: campaignId },
      tx,
    )
  })
}
