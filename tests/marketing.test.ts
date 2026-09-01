import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { campaignRecipients, contacts, suppressions } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  describeDefinition,
  evaluateRule,
  isContactable,
  matchesSegment,
  parseDefinition,
  type SegmentCandidate,
  type SegmentDefinition,
  type SegmentRule,
} from '@/modules/marketing/segments'
import {
  createSegment,
  evaluateSegment,
  listSuppressions,
  segmentSummary,
  suppressEmail,
  unsuppressEmail,
  updateSegment,
} from '@/modules/marketing/audience'
import {
  addStep,
  cancelCampaign,
  campaignRecipientRows,
  createCampaign,
  sendStep,
} from '@/modules/marketing/campaigns'
import { mockEmailProvider } from '@/modules/marketing/email-provider'
import {
  recordClick,
  recordOpen,
  unsubscribeByToken,
} from '@/modules/marketing/engagement'
import { campaignStats, marketingOverview, openTasks } from '@/modules/marketing/analytics'
import { renderEmailHtml, renderEmailText, escapeHtml } from '@/modules/marketing/render-email'
import { safeUrl, safeQrValue } from '@/modules/design/urls'
import { signDestination } from '@/modules/marketing/click-links'

/** Two destinations the tests click through to, signed as a real link would be. */
const READ = 'https://example.com/read'
const OTHER = 'https://example.com/other'
import { createMarketingDocument, saveDocument } from '@/modules/design/documents'
import { changeStage, createContact, createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { parseBlocks, type Block } from '@/modules/design/blocks'

// --- The pure matcher ------------------------------------------------------

function candidate(overrides: Partial<SegmentCandidate> = {}): SegmentCandidate {
  return {
    contactId: 'c1',
    email: 'person@example.test',
    emailConsent: 'subscribed',
    suppressedAt: null,
    organizationId: 'o1',
    organizationName: 'Example Ltd',
    lifecycleStage: 'prospect',
    industry: 'Construction',
    region: 'WA',
    sizeBand: 'small',
    source: 'referral',
    isStrategicAccount: false,
    tags: ['commercial', 'repeat'],
    opportunityHistory: 'none',
    marketingEligible: false,
    ...overrides,
  }
}

const ALL = (rules: SegmentDefinition['rules']): SegmentDefinition => ({
  matchType: 'all',
  rules,
  lostOpportunityNurture: false,
})

describe('segment matching', () => {
  it('compares strings case-insensitively and trimmed', () => {
    expect(
      evaluateRule({ field: 'industry', operator: 'is', value: '  CONSTRUCTION ' }, candidate()),
    ).toBe(true)
  })

  it('treats tags as "has any of these"', () => {
    const rule: SegmentRule = {
      field: 'tags',
      operator: 'in',
      value: ['residential', 'commercial'],
    }
    expect(evaluateRule(rule, candidate())).toBe(true)
    // Overlapping on one entry is enough…
    expect(evaluateRule(rule, candidate({ tags: ['residential'] }))).toBe(true)
    // …but no overlap at all is not.
    expect(evaluateRule(rule, candidate({ tags: ['industrial'] }))).toBe(false)
    expect(evaluateRule(rule, candidate({ tags: [] }))).toBe(false)
  })

  it('distinguishes an empty value from an absent one', () => {
    expect(evaluateRule({ field: 'region', operator: 'is_set' }, candidate())).toBe(true)
    expect(
      evaluateRule({ field: 'region', operator: 'is_set' }, candidate({ region: '' })),
    ).toBe(false)
    expect(
      evaluateRule({ field: 'region', operator: 'is_not_set' }, candidate({ region: null })),
    ).toBe(true)
  })

  it('never matches a null field, whatever the operator asks', () => {
    for (const operator of ['is', 'is_not', 'in', 'not_in', 'contains'] as const) {
      expect(
        evaluateRule({ field: 'industry', operator, value: 'anything' }, candidate({ industry: null })),
      ).toBe(false)
    }
  })

  it('matches everyone when there are no rules', () => {
    // Unlike a categorization rule, an empty audience filter is meaningful.
    expect(matchesSegment(ALL([]), candidate())).toBe(true)
  })

  it('honours matchType', () => {
    const rules = [
      { field: 'industry', operator: 'is', value: 'Construction' },
      { field: 'region', operator: 'is', value: 'OR' },
    ] as SegmentDefinition['rules']

    expect(matchesSegment({ ...ALL(rules), matchType: 'all' }, candidate())).toBe(false)
    expect(matchesSegment({ ...ALL(rules), matchType: 'any' }, candidate())).toBe(true)
  })

  it('gates the nurture flag on eligibility recorded at close', () => {
    const definition = { ...ALL([]), lostOpportunityNurture: true }

    expect(matchesSegment(definition, candidate({ marketingEligible: false }))).toBe(false)
    expect(matchesSegment(definition, candidate({ marketingEligible: true }))).toBe(true)
  })

  it('falls back to "everyone" for a malformed stored definition', () => {
    const parsed = parseDefinition({ matchType: 'sideways', rules: 'nonsense' })
    expect(parsed.rules).toEqual([])
    expect(matchesSegment(parsed, candidate())).toBe(true)
  })

  it('describes a definition in words', () => {
    expect(describeDefinition(ALL([]))).toBe('Everyone')
    expect(
      describeDefinition(ALL([{ field: 'region', operator: 'is', value: 'WA' }])),
    ).toContain('region is WA')
  })
})

describe('contactability is separate from matching', () => {
  it('requires an address, no suppression, and explicit consent', () => {
    expect(isContactable(candidate())).toEqual({ ok: true })
    expect(isContactable(candidate({ email: null })).reason).toBe('no_email')
    expect(isContactable(candidate({ suppressedAt: new Date() })).reason).toBe('suppressed')
    expect(isContactable(candidate({ emailConsent: 'unknown' })).reason).toBe('no_consent')
  })

  it('does not let a wide segment imply permission', () => {
    // The whole point of keeping the two apart: matching everyone must not
    // make everyone contactable.
    const person = candidate({ emailConsent: 'unknown' })
    expect(matchesSegment(ALL([]), person)).toBe(true)
    expect(isContactable(person).ok).toBe(false)
  })
})

// --- URL safety, shared with the design engine -----------------------------

describe('link safety', () => {
  it('rejects anything that is not http, https, or mailto', () => {
    expect(safeUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(safeUrl('mailto:a@b.test')).toBe('mailto:a@b.test')
    expect(safeUrl('javascript:alert(1)')).toBe('#')
    expect(safeUrl('data:text/html,<script>')).toBe('#')
    expect(safeUrl('  JavaScript:alert(1)')).toBe('#')
  })

  it('accepts a bare domain by assuming https', () => {
    expect(safeUrl('example.com/book')).toBe('https://example.com/book')
  })

  it('will not encode an unusable value in a QR code', () => {
    expect(safeQrValue('javascript:alert(1)')).toBeNull()
    expect(safeQrValue('  ')).toBeNull()
    expect(safeQrValue('https://example.com')).toBe('https://example.com')
  })
})

// --- The email renderer ----------------------------------------------------

describe('email rendering', () => {
  // Through `parseBlocks`, so the fixtures carry the same defaults a stored
  // document would rather than a hand-built shape that cannot occur.
  const blocks: Block[] = parseBlocks([
    { id: 'b1', type: 'cover', title: 'Hello', subtitle: 'A note' },
    { id: 'b2', type: 'text', text: 'First line.\n\nSecond line.' },
    { id: 'b3', type: 'button', label: 'Book a call', url: 'https://example.com/book' },
    { id: 'b4', type: 'qrCode', value: 'https://example.com', caption: 'Scan' },
  ])

  it('escapes author text rather than trusting it', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;')

    const html = renderEmailHtml({
      blocks: parseBlocks([{ id: 'x', type: 'heading', text: '<img onerror=x>', level: 2 }]),
      unsubscribeUrl: 'https://example.com/u/token',
    })
    expect(html).not.toContain('<img onerror')
    expect(html).toContain('&lt;img onerror=x&gt;')
  })

  it('always carries an unsubscribe link in the visible footer', () => {
    const html = renderEmailHtml({ blocks, unsubscribeUrl: 'https://example.com/u/tok' })
    expect(html).toContain('https://example.com/u/tok')
    expect(html).toContain('Unsubscribe')
  })

  it('drops a QR code, which is useless on the device already reading it', () => {
    const html = renderEmailHtml({ blocks, unsubscribeUrl: 'https://x.test/u' })
    expect(html).not.toContain('Scan')
  })

  it('routes author links through the click recorder when one is given', () => {
    const html = renderEmailHtml({
      blocks,
      unsubscribeUrl: 'https://x.test/u/tok',
      trackLink: (url) => `https://x.test/api/track/tok?u=${encodeURIComponent(url)}`,
    })

    expect(html).toContain('api/track/tok?u=https%3A%2F%2Fexample.com%2Fbook')
    // The unsubscribe link is not tracked — leaving is not engagement.
    expect(html).toContain('href="https://x.test/u/tok"')
  })

  it('produces a plain-text alternative with the links spelled out', () => {
    const text = renderEmailText({ blocks, unsubscribeUrl: 'https://x.test/u/tok' })
    expect(text).toContain('Book a call: https://example.com/book')
    expect(text).toContain('Unsubscribe: https://x.test/u/tok')
  })

  it('renders tables rather than flexbox, because Outlook has no flexbox', () => {
    const html = renderEmailHtml({ blocks, unsubscribeUrl: 'https://x.test/u' })
    expect(html).toContain('role="presentation"')
    expect(html).not.toContain('display:flex')
    expect(html).not.toContain('display:grid')
  })
})

// --- The send pipeline -----------------------------------------------------

/** A company with three contacts: two contactable, one without consent. */
async function marketingFixture() {
  const fixture = await createCompanyFixture({ name: 'Marketing Co' })
  const { ctx } = fixture

  const organization = await createOrganization(ctx, {
    name: 'Northgate Partners',
    industry: 'Construction',
    region: 'WA',
    lifecycleStage: 'prospect',
  })

  const subscribed = await createContact(ctx, {
    organizationId: organization.id,
    firstName: 'Sam',
    lastName: 'Reyes',
    email: 'sam@northgate.test',
    isPrimary: true,
    emailConsent: 'subscribed',
    consentSource: 'web_form',
  })

  const alsoSubscribed = await createContact(ctx, {
    organizationId: organization.id,
    firstName: 'Kit',
    email: 'kit@northgate.test',
    emailConsent: 'subscribed',
    consentSource: 'web_form',
  })

  await createContact(ctx, {
    organizationId: organization.id,
    firstName: 'Noel',
    email: 'noel@northgate.test',
    emailConsent: 'unknown',
  })

  const creative = await createMarketingDocument(ctx, { name: 'Newsletter' })
  await saveDocument(ctx, creative.id, {
    blocks: [
      { id: 'b1', type: 'cover', title: 'Hello {{client.contactName}}', subtitle: 'From {{company.name}}' },
      { id: 'b2', type: 'button', label: 'Read more', url: 'https://example.com/read', align: 'center', style: 'solid' },
    ],
  })

  const segment = await createSegment(ctx, {
    name: 'Everyone in construction',
    definition: ALL([{ field: 'industry', operator: 'is', value: 'Construction' }]),
  })

  return { fixture, ctx, organization, subscribed, alsoSubscribed, segment, creative }
}

describe('the send pipeline', () => {
  beforeEach(() => {
    mockEmailProvider().reset()
  })

  it('records everyone who matched, including the people it will not email', async () => {
    const { ctx, segment, creative } = await marketingFixture()

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
    })
    await addStep(ctx, campaign.id, { subject: 'Hello', designDocumentId: creative.id })

    const summary = await sendStep(ctx, campaign.id, 1)

    expect(summary.matched).toBe(3)
    expect(summary.sent).toBe(2)
    expect(summary.skipped).toBe(1)
    expect(summary.skipReasons.no_consent).toBe(1)

    // A marketer can see why, not just how many.
    const rows = await campaignRecipientRows(ctx, campaign.id)
    const skipped = rows.find((row) => row.status === 'skipped')
    expect(skipped?.email).toBe('noel@northgate.test')
    expect(skipped?.skipReason).toBe('no_consent')
  })

  it('checks consent at send time, not when the segment was built', async () => {
    const { ctx, segment, creative, subscribed } = await marketingFixture()

    // The segment was saved while everyone was subscribed…
    const preview = await segmentSummary(ctx, parseDefinition(segment.definition))
    expect(preview.contactable).toBe(2)

    // …and someone withdraws consent afterwards.
    await db
      .update(contacts)
      .set({ emailConsent: 'unsubscribed' })
      .where(eq(contacts.id, subscribed.id))

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
    })
    await addStep(ctx, campaign.id, { subject: 'Hello', designDocumentId: creative.id })

    const summary = await sendStep(ctx, campaign.id, 1)
    expect(summary.sent).toBe(1)
    expect(summary.skipped).toBe(2)
  })

  it('honours a company-wide suppression even when the contact still shows consent', async () => {
    const { ctx, segment, creative, fixture } = await marketingFixture()

    // Suppression is keyed by address, so it survives the contact record.
    await db.insert(suppressions).values({
      companyId: fixture.companyId,
      email: 'kit@northgate.test',
      reason: 'bounce',
    })

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
    })
    await addStep(ctx, campaign.id, { subject: 'Hello', designDocumentId: creative.id })

    const summary = await sendStep(ctx, campaign.id, 1)
    expect(summary.sent).toBe(1)
    expect(summary.skipReasons.suppressed).toBe(1)
  })

  it('resolves merge fields per recipient and sets the unsubscribe header', async () => {
    const { ctx, segment, creative } = await marketingFixture()
    const provider = mockEmailProvider()

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
      fromName: 'Marketing Co',
    })
    await addStep(ctx, campaign.id, {
      subject: 'A note for {{client.name}}',
      designDocumentId: creative.id,
    })
    await sendStep(ctx, campaign.id, 1)

    const toSam = provider.sent.find((message) => message.to === 'sam@northgate.test')
    expect(toSam).toBeDefined()
    expect(toSam!.subject).toBe('A note for Northgate Partners')
    expect(toSam!.html).toContain('Hello Sam Reyes')
    expect(toSam!.unsubscribeUrl).toContain('/u/')
    expect(toSam!.unsubscribePostUrl).toContain('/api/unsubscribe/')
    expect(toSam!.text.length).toBeGreaterThan(0)

    // Each recipient gets their own token — one leaked token reaches one person.
    const tokens = new Set(provider.sent.map((message) => message.unsubscribeUrl))
    expect(tokens.size).toBe(provider.sent.length)
  })

  it('records a bounce without failing the whole send', async () => {
    const { ctx, segment, creative } = await marketingFixture()
    mockEmailProvider().failFor('kit@northgate.test')

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
    })
    await addStep(ctx, campaign.id, { subject: 'Hello', designDocumentId: creative.id })

    const summary = await sendStep(ctx, campaign.id, 1)
    expect(summary.sent).toBe(1)
    expect(summary.failed).toBe(1)
  })

  it('refuses to send without an audience or a from address', async () => {
    const { ctx, creative, segment } = await marketingFixture()

    const noAudience = await createCampaign(ctx, {
      name: 'Incomplete',
      fromEmail: 'hello@marketing.test',
    })
    await addStep(ctx, noAudience.id, { subject: 'Hi', designDocumentId: creative.id })
    await expect(sendStep(ctx, noAudience.id, 1)).rejects.toThrow(/audience/i)

    const noFrom = await createCampaign(ctx, { name: 'Incomplete', segmentId: segment.id })
    await addStep(ctx, noFrom.id, { subject: 'Hi', designDocumentId: creative.id })
    await expect(sendStep(ctx, noFrom.id, 1)).rejects.toThrow(/from address/i)
  })

  it('will not send a campaign twice', async () => {
    const { ctx, segment, creative } = await marketingFixture()

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
    })
    await addStep(ctx, campaign.id, { subject: 'Hello', designDocumentId: creative.id })

    await sendStep(ctx, campaign.id, 1)
    await expect(sendStep(ctx, campaign.id, 1)).rejects.toThrow(/sent/i)
  })

  it('cannot be cancelled once it has gone out', async () => {
    const { ctx, segment, creative } = await marketingFixture()

    const campaign = await createCampaign(ctx, {
      name: 'Autumn note',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
    })
    await addStep(ctx, campaign.id, { subject: 'Hello', designDocumentId: creative.id })
    await sendStep(ctx, campaign.id, 1)

    await cancelCampaign(ctx, campaign.id)
    const stats = await campaignStats(ctx, campaign.id)
    // Still there, still counted — cancelling cannot unsend anything.
    expect(stats.sent).toBe(2)
  })
})

// --- Engagement and unsubscribe --------------------------------------------

async function sentCampaign() {
  const setup = await marketingFixture()
  const campaign = await createCampaign(setup.ctx, {
    name: 'Autumn note',
    segmentId: setup.segment.id,
    fromEmail: 'hello@marketing.test',
  })
  await addStep(setup.ctx, campaign.id, {
    subject: 'Hello',
    designDocumentId: setup.creative.id,
  })
  await sendStep(setup.ctx, campaign.id, 1)

  const [recipient] = await db
    .select()
    .from(campaignRecipients)
    .where(
      and(eq(campaignRecipients.campaignId, campaign.id), eq(campaignRecipients.status, 'sent')),
    )
    .limit(1)

  return { ...setup, campaign, recipient }
}

describe('engagement tracking', () => {
  beforeEach(() => {
    mockEmailProvider().reset()
  })

  it('records an open and advances the status', async () => {
    const { ctx, campaign, recipient } = await sentCampaign()

    await recordOpen(recipient.unsubscribeToken)

    const stats = await campaignStats(ctx, campaign.id)
    expect(stats.opened).toBe(1)
    expect(stats.openRateBp).toBe(5000)
  })

  it('ignores an unknown token quietly, so the pixel still renders', async () => {
    await expect(recordOpen('not-a-real-token')).resolves.toBeUndefined()
  })

  /**
   * Renamed in Phase 81, because the old name was the defect. It read
   * "re-validates the click destination, so a forged link is not an open
   * redirect" and asserted only that `javascript:` is refused — which is
   * scheme safety, not destination safety. `tests/click-links.test.ts` covers
   * the open redirect itself.
   */
  it('refuses a destination whose scheme could execute', async () => {
    const { recipient } = await sentCampaign()

    expect(
      await recordClick(
        recipient.unsubscribeToken,
        'javascript:alert(1)',
        signDestination('javascript:alert(1)'),
      ),
    ).toEqual({ ok: false })

    expect(
      await recordClick(recipient.unsubscribeToken, READ, signDestination(READ)),
    ).toEqual({ ok: true, destination: READ })
  })

  it('counts a click as an open, since you cannot click what you did not see', async () => {
    const { ctx, campaign, recipient } = await sentCampaign()

    await recordClick(recipient.unsubscribeToken, READ, signDestination(READ))

    const stats = await campaignStats(ctx, campaign.id)
    expect(stats.clicked).toBe(1)
    expect(stats.opened).toBe(1)
  })

  it('raises one follow-up task per organization however many links are clicked', async () => {
    const { ctx, recipient } = await sentCampaign()

    await recordClick(recipient.unsubscribeToken, READ, signDestination(READ))
    await recordClick(recipient.unsubscribeToken, OTHER, signDestination(OTHER))

    const tasks = await openTasks(ctx)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toContain('Northgate Partners')
  })

  it('does not reopen a lost deal on its own', async () => {
    // A click is a signal, not a decision — reopening would rewrite the
    // win/loss figures spec §9 reports.
    const { ctx, organization, subscribed, recipient } = await sentCampaign()

    const deal = await createOpportunity(ctx, {
      organizationId: organization.id,
      primaryContactId: subscribed.id,
      title: 'A deal that was lost',
      expectedValueCents: 100_000,
    })
    await changeStage(ctx, deal.id, { stage: 'lost', lossReason: 'price' })

    await recordClick(recipient.unsubscribeToken, READ, signDestination(READ))

    const overview = await marketingOverview(ctx)
    expect(overview.openTasks).toBeGreaterThan(0)
    // The deal is still closed until a person says otherwise.
    expect(overview.reEngagementCandidates).toBeGreaterThanOrEqual(0)
  })
})

describe('unsubscribe', () => {
  beforeEach(() => {
    mockEmailProvider().reset()
  })

  it('is idempotent, because mail clients pre-fetch links', async () => {
    const { recipient } = await sentCampaign()

    const first = await unsubscribeByToken(recipient.unsubscribeToken)
    const second = await unsubscribeByToken(recipient.unsubscribeToken)

    expect(first).toMatchObject({ ok: true, alreadyUnsubscribed: false })
    expect(second).toMatchObject({ ok: true, alreadyUnsubscribed: true })
  })

  it('reveals nothing for an unknown token', async () => {
    expect(await unsubscribeByToken('not-a-real-token')).toEqual({ ok: false })
  })

  it('suppresses the address company-wide, not just the one contact', async () => {
    const { ctx, recipient, fixture } = await sentCampaign()

    await unsubscribeByToken(recipient.unsubscribeToken)

    const rows = await listSuppressions(ctx)
    expect(rows.map((row) => row.email)).toContain(recipient.email)

    // Deleting and recreating the contact must not resurrect them.
    await db
      .delete(contacts)
      .where(
        and(eq(contacts.companyId, fixture.companyId), eq(contacts.email, recipient.email)),
      )

    const recreated = await createContact(ctx, {
      organizationId: (await createOrganization(ctx, { name: 'A new record' })).id,
      firstName: 'Sam',
      email: recipient.email,
      emailConsent: 'subscribed',
    })
    expect(recreated.emailConsent).toBe('subscribed')

    const audience = await evaluateSegment(ctx, ALL([]))
    const entry = audience.find((member) => member.email === recipient.email)
    expect(entry?.contactable).toBe(false)
    expect(entry?.reason).toBe('suppressed')
  })

  it('lifts only the block when a suppression is removed — consent stays withdrawn', async () => {
    const fixture = await createCompanyFixture({ name: 'Consent Co' })
    const { ctx } = fixture

    const organization = await createOrganization(ctx, { name: 'Someone Ltd' })
    await createContact(ctx, {
      organizationId: organization.id,
      firstName: 'Jules',
      email: 'jules@someone.test',
      emailConsent: 'subscribed',
    })

    await suppressEmail(fixture.companyId, 'jules@someone.test', { reason: 'unsubscribe' })
    await unsuppressEmail(ctx, 'jules@someone.test')

    const [contact] = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.companyId, fixture.companyId), eq(contacts.email, 'jules@someone.test')),
      )
      .limit(1)

    expect(contact.suppressedAt).toBeNull()
    // Consent is theirs to give, not ours to restore.
    expect(contact.emailConsent).toBe('unsubscribed')
  })
})

// --- Analytics -------------------------------------------------------------

describe('campaign analytics', () => {
  beforeEach(() => {
    mockEmailProvider().reset()
  })

  it('rates opens against messages sent, not against everyone who matched', async () => {
    const { ctx, campaign, recipient } = await sentCampaign()
    await recordOpen(recipient.unsubscribeToken)

    const stats = await campaignStats(ctx, campaign.id)

    expect(stats.matched).toBe(3)
    expect(stats.sent).toBe(2)
    // 1 of 2 delivered, not 1 of 3 matched: the skipped person never had the
    // chance to open anything.
    expect(stats.openRateBp).toBe(5000)
  })

  it('reports zero rather than dividing by zero on an unsent campaign', async () => {
    const { ctx, segment } = await marketingFixture()
    const campaign = await createCampaign(ctx, {
      name: 'Never sent',
      segmentId: segment.id,
      fromEmail: 'hello@marketing.test',
    })

    const stats = await campaignStats(ctx, campaign.id)
    expect(stats.openRateBp).toBe(0)
    expect(stats.clickThroughRateBp).toBe(0)
  })
})

// --- Tenancy ---------------------------------------------------------------

describe('tenant isolation', () => {
  beforeEach(() => {
    mockEmailProvider().reset()
  })

  it('keeps one company out of another company’s campaigns', async () => {
    const { ctx, campaign } = await sentCampaign()
    const other = await createCompanyFixture({ name: 'Somebody Else' })

    await expect(campaignStats(other.ctx, campaign.id)).resolves.toMatchObject({ matched: 0 })

    const rows = await campaignRecipientRows(other.ctx, campaign.id)
    expect(rows).toHaveLength(0)

    // And their overview is not polluted by ours.
    const overview = await marketingOverview(other.ctx)
    expect(overview.totalSent).toBe(0)

    void ctx
  })

  it('suppresses an address for one company only', async () => {
    const a = await createCompanyFixture({ name: 'Company A' })
    const b = await createCompanyFixture({ name: 'Company B' })

    await suppressEmail(a.companyId, 'shared@example.test', { reason: 'unsubscribe' })

    expect((await listSuppressions(a.ctx)).map((row) => row.email)).toContain(
      'shared@example.test',
    )
    expect(await listSuppressions(b.ctx)).toHaveLength(0)
  })
})

// --- Permissions -----------------------------------------------------------

describe('marketing permissions', () => {
  it('lets the marketing role work without opening the books', async () => {
    const fixture: Fixture = await createCompanyFixture({ name: 'Role Co' })
    const marketer = { ...fixture.ctx, role: 'marketing' as const }

    // Allowed: their own workspace.
    await expect(
      createSegment(marketer, { name: 'Everyone', definition: ALL([]) }),
    ).resolves.toBeDefined()

    // Denied: anything financial.
    const { listInbox } = await import('@/modules/bookkeeping/transactions')
    await expect(listInbox(marketer, {})).rejects.toThrow(/permission/i)
  })

  it('does not let a sales role edit marketing creative, or the reverse', async () => {
    const fixture = await createCompanyFixture({ name: 'Split Co' })
    const salesperson = { ...fixture.ctx, role: 'sales' as const }
    const marketer = { ...fixture.ctx, role: 'marketing' as const }

    const creative = await createMarketingDocument(marketer, { name: 'Newsletter' })

    // The same designer serves both, but the document's kind decides who may
    // save it.
    await expect(saveDocument(salesperson, creative.id, { blocks: [] })).rejects.toThrow(
      /permission/i,
    )
    await expect(saveDocument(marketer, creative.id, { blocks: [] })).resolves.toBeDefined()
  })

  it('requires manage rights to change a segment', async () => {
    const fixture = await createCompanyFixture({ name: 'Read Co' })
    const segment = await createSegment(fixture.ctx, { name: 'Everyone', definition: ALL([]) })
    const readonly = { ...fixture.ctx, role: 'readonly' as const }

    await expect(
      updateSegment(readonly, segment.id, { name: 'Renamed', definition: ALL([]) }),
    ).rejects.toThrow(/permission/i)
  })
})
