import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companyProfiles } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { OUR_NAME } from '@/modules/brand/voice'
import { createSegment } from '@/modules/marketing/audience'
import { addStep, createCampaign, sendStep } from '@/modules/marketing/campaigns'
import { mockEmailProvider } from '@/modules/marketing/email-provider'
import { createMarketingDocument, saveDocument } from '@/modules/design/documents'
import { createContact, createOrganization } from '@/modules/crm/opportunities'
import { PageCanvas, writePdf } from '@/modules/pdf/writer'
import { transactionalSender } from '@/modules/notify/transactional'

/**
 * Whose name is on the letter (Phase 74).
 *
 * The same string, `'Accountrix Plus'`, was written into six modules as a
 * literal and meant two opposite things. These tests hold the line between
 * them: a letter the **product** sends may carry our name, and a letter a
 * **company** sends never may.
 */

/** A company with one contactable person and a creative. */
async function company(companyName: string) {
  const fixture = await createCompanyFixture({ name: companyName })
  const { ctx } = fixture

  const organization = await createOrganization(ctx, {
    name: 'Northgate Partners',
    industry: 'Construction',
    region: 'WA',
    lifecycleStage: 'prospect',
  })

  await createContact(ctx, {
    organizationId: organization.id,
    firstName: 'Sam',
    email: 'sam@northgate.test',
    emailConsent: 'subscribed',
    consentSource: 'web_form',
  })

  const creative = await createMarketingDocument(ctx, { name: 'Newsletter' })
  await saveDocument(ctx, creative.id, {
    blocks: [{ id: 'b1', type: 'cover', title: 'Hello', subtitle: 'From {{company.name}}' }],
  })

  const segment = await createSegment(ctx, {
    name: 'Everyone in construction',
    definition: {
      matchType: 'all',
      rules: [{ field: 'industry', operator: 'is', value: 'Construction' }],
      lostOpportunityNurture: false,
    },
  })

  return { fixture, ctx, segment, creative }
}

describe('a letter a company sends', () => {
  beforeEach(() => {
    mockEmailProvider().reset()
  })

  async function sendOne(companyName: string, fromName?: string) {
    const { ctx, segment, creative } = await company(companyName)

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromName,
      fromEmail: 'hello@ridgeline.test',
    })
    await addStep(ctx, campaign.id, { subject: 'Hello', designDocumentId: creative.id })

    return { ctx, campaign, creative, segment }
  }

  /**
   * The reachable one. Onboarding writes a profile whose legal name is the
   * company name, but the Design Center's Legal name box is
   * `z.string().trim().max(200).optional()` with no `.min(1)`, and the form is
   * controlled — clearing it saves `''`.
   *
   * `''` is not null, so the old `??` chain did not fall through to anything.
   * Every campaign this company sent went out from **nobody**.
   */
  it('does not send from an empty name when the legal name was cleared', async () => {
    const { ctx, campaign } = await sendOne('Ridgeline Construction')

    await db
      .update(companyProfiles)
      .set({ legalName: '' })
      .where(eq(companyProfiles.companyId, ctx.companyId))

    await sendStep(ctx, campaign.id, 1)

    const [message] = mockEmailProvider().sent
    expect(message.fromName).toBe('Ridgeline Construction')
    expect(message.fromName).not.toBe(OUR_NAME)
  })

  /**
   * The other one. `companyProfiles` is a separate table and its `legalName` is
   * nullable, so a company that arrived any way other than through onboarding —
   * an import, a seed, a company created before Phase 4 — has no name in it.
   * That is where the old chain ended `?? 'Accountrix Plus'`: a business mailing
   * its own customers under our name, over its own unsubscribe link.
   */
  it('sends from the company itself when there is no profile at all', async () => {
    const { ctx, campaign } = await sendOne('Ridgeline Construction')

    await db.delete(companyProfiles).where(eq(companyProfiles.companyId, ctx.companyId))

    await sendStep(ctx, campaign.id, 1)

    const [message] = mockEmailProvider().sent
    expect(message.fromName).toBe('Ridgeline Construction')
    expect(message.fromName).not.toBe(OUR_NAME)
  })

  /** `{{company.name}}` resolved to nothing at all without a profile. */
  it('resolves the company merge field to the company', async () => {
    const { ctx, campaign } = await sendOne('Ridgeline Construction')

    await db.delete(companyProfiles).where(eq(companyProfiles.companyId, ctx.companyId))

    await sendStep(ctx, campaign.id, 1)

    expect(mockEmailProvider().sent[0].html).toContain('From Ridgeline Construction')
  })

  it('still prefers what the marketer chose for this campaign', async () => {
    const { ctx, campaign } = await sendOne('Ridgeline Construction', 'Ridgeline Site Team')

    await sendStep(ctx, campaign.id, 1)

    expect(mockEmailProvider().sent[0].fromName).toBe('Ridgeline Site Team')
  })
})

/**
 * The other half of the rule. These letters really are from the product, and
 * signing them with a company's name would be the lie in the other direction —
 * a password reset that looks like it came from your employer is one you cannot
 * tell from a phishing attempt made by somebody who knows where you work.
 */
describe('a letter the product sends', () => {
  it('carries our name, read from the brand rather than typed again', () => {
    expect(transactionalSender().fromName).toBe(OUR_NAME)
  })

  it('names us as the producer of a PDF', () => {
    const pdf = writePdf({
      title: 'Invoice INV-1001',
      // The *company* is the author. It is their document; we only made it.
      author: 'Ridgeline Construction',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      pages: [new PageCanvas(612, 792)],
    })

    expect(pdf.toString('latin1')).toContain(`/Producer (${OUR_NAME})`)
  })
})
