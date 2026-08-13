import { describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  contacts,
  leadIntakeKeys,
  leadSubmissions,
  opportunities,
  organizations,
} from '@/db/schema'
import { createCompanyFixture, addUserWithRole } from './helpers'
import {
  createIntakeKey,
  listIntakeKeys,
  originAllowed,
  revokeIntakeKey,
  submitLead,
  truncateIp,
} from '@/modules/crm/intake'
import { PermissionError } from '@/modules/permissions'

/**
 * Public lead intake (spec §6).
 *
 * This is the only unauthenticated write path in the system, so the tests
 * lean on what an attacker would try rather than only the happy path.
 */

const VALID = {
  name: 'Jo Rivera',
  email: 'jo@harborview.test',
  organizationName: 'Harborview Development',
  message: 'We need a quote for a foundation package.',
  interest: 'Foundation package',
}

describe('address truncation', () => {
  it('keeps only the network prefix of an IPv4 address', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0/24')
  })

  it('keeps only the routing prefix of an IPv6 address', () => {
    expect(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3::/64')
  })

  it('uses the first address from a forwarded chain', () => {
    expect(truncateIp('203.0.113.42, 198.51.100.7')).toBe('203.0.113.0/24')
  })

  it('returns null for missing or malformed input', () => {
    expect(truncateIp(null)).toBeNull()
    expect(truncateIp('not-an-address')).toBeNull()
  })
})

describe('origin allowlist', () => {
  it('permits any origin when the list is empty', () => {
    expect(originAllowed([], 'https://example.test')).toBe(true)
    expect(originAllowed([], null)).toBe(true)
  })

  it('permits only listed origins when the list is set', () => {
    expect(originAllowed(['https://example.test'], 'https://example.test')).toBe(true)
    expect(originAllowed(['https://example.test'], 'https://evil.test')).toBe(false)
  })

  it('refuses a missing origin when a list is set', () => {
    expect(originAllowed(['https://example.test'], null)).toBe(false)
  })

  it('ignores a trailing slash and case', () => {
    expect(originAllowed(['https://Example.test/'], 'https://example.test')).toBe(true)
  })
})

async function keyFixture(overrides: { hourlyLimit?: number; allowedOrigins?: string[] } = {}) {
  const fixture = await createCompanyFixture()
  const key = await createIntakeKey(fixture.ctx, {
    name: 'Website contact form',
    hourlyLimit: overrides.hourlyLimit,
    allowedOrigins: overrides.allowedOrigins,
  })
  return { fixture, key }
}

describe('accepting a lead', () => {
  it('creates an organization, contact, and opportunity', async () => {
    const { fixture, key } = await keyFixture()

    const result = await submitLead(key.publicKey, VALID, { ip: '203.0.113.42' })
    expect(result.ok).toBe(true)

    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.companyId, fixture.companyId))
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, fixture.companyId))
    const [opportunity] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.companyId, fixture.companyId))

    expect(organization.name).toBe('Harborview Development')
    expect(organization.lifecycleStage).toBe('lead')
    expect(organization.source).toBe('website')
    expect(contact.firstName).toBe('Jo')
    expect(contact.lastName).toBe('Rivera')
    expect(opportunity.stage).toBe('new_inquiry')
    expect(opportunity.title).toBe('Foundation package')
  })

  it('never infers consent from silence', async () => {
    const { fixture, key } = await keyFixture()
    await submitLead(key.publicKey, VALID)

    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, fixture.companyId))

    expect(contact.emailConsent).toBe('unknown')
    expect(contact.consentAt).toBeNull()
  })

  it('records consent only when explicitly given', async () => {
    const { fixture, key } = await keyFixture()
    await submitLead(key.publicKey, { ...VALID, marketingConsent: true })

    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, fixture.companyId))

    expect(contact.emailConsent).toBe('subscribed')
    expect(contact.consentSource).toBe('website_intake')
    expect(contact.consentAt).not.toBeNull()
  })

  it('reuses an existing organization on a repeat submission', async () => {
    const { fixture, key } = await keyFixture()

    await submitLead(key.publicKey, VALID)
    await submitLead(key.publicKey, { ...VALID, message: 'Following up.' })

    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.companyId, fixture.companyId))
    const opps = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.companyId, fixture.companyId))

    // One organization, but both inquiries are kept.
    expect(orgs).toHaveLength(1)
    expect(opps).toHaveLength(2)
  })

  it('stores only a truncated address', async () => {
    const { fixture, key } = await keyFixture()
    await submitLead(key.publicKey, VALID, { ip: '203.0.113.42' })

    const [submission] = await db
      .select()
      .from(leadSubmissions)
      .where(eq(leadSubmissions.companyId, fixture.companyId))

    expect(submission.ipPrefix).toBe('203.0.113.0/24')
    expect(submission.accepted).toBe(true)
  })

  it('logs the intake as the first activity on the opportunity', async () => {
    const { fixture, key } = await keyFixture()
    await submitLead(key.publicKey, VALID)

    const { opportunityActivities } = await import('@/db/schema')
    const [activity] = await db
      .select()
      .from(opportunityActivities)
      .where(eq(opportunityActivities.companyId, fixture.companyId))

    expect(activity.kind).toBe('lead_intake')
    expect(activity.actorName).toBe('Website intake')
  })
})

describe('rejecting a submission', () => {
  it('refuses an unknown key without revealing whether it exists', async () => {
    const result = await submitLead('pk_does_not_exist', VALID)

    expect(result).toMatchObject({ ok: false, status: 404, reason: 'unknown_key' })
  })

  it('refuses a revoked key the same way', async () => {
    const { fixture, key } = await keyFixture()
    await revokeIntakeKey(fixture.ctx, key.id)

    const result = await submitLead(key.publicKey, VALID)
    expect(result).toMatchObject({ ok: false, reason: 'unknown_key' })
  })

  it('refuses an origin outside the allowlist', async () => {
    const { key } = await keyFixture({ allowedOrigins: ['https://ridgeline.test'] })

    const blocked = await submitLead(key.publicKey, VALID, { origin: 'https://evil.test' })
    expect(blocked).toMatchObject({ ok: false, status: 403, reason: 'origin' })

    const allowed = await submitLead(key.publicKey, VALID, {
      origin: 'https://ridgeline.test',
    })
    expect(allowed.ok).toBe(true)
  })

  it('rejects a payload that fails validation', async () => {
    const { key } = await keyFixture()

    const noName = await submitLead(key.publicKey, { email: 'a@b.test' })
    expect(noName).toMatchObject({ ok: false, status: 400, reason: 'invalid' })

    const badEmail = await submitLead(key.publicKey, { name: 'Jo', email: 'not-an-email' })
    expect(badEmail).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('caps oversized fields rather than storing them', async () => {
    const { key } = await keyFixture()

    const result = await submitLead(key.publicKey, {
      name: 'Jo',
      message: 'x'.repeat(10_000),
    })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('swallows a honeypot submission while reporting success', async () => {
    const { fixture, key } = await keyFixture()

    // Reported as ok so an automated submitter learns nothing.
    const result = await submitLead(key.publicKey, { ...VALID, website: 'http://spam.test' })
    expect(result.ok).toBe(true)

    // But nothing was created.
    const opps = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.companyId, fixture.companyId))
    expect(opps).toHaveLength(0)

    const [submission] = await db
      .select()
      .from(leadSubmissions)
      .where(eq(leadSubmissions.companyId, fixture.companyId))
    expect(submission.accepted).toBe(false)
    expect(submission.rejectionReason).toBe('honeypot')
  })

  it('rate limits once the hourly allowance is used up', async () => {
    const { fixture, key } = await keyFixture({ hourlyLimit: 3 })

    for (let i = 0; i < 3; i++) {
      const result = await submitLead(key.publicKey, { ...VALID, name: `Person ${i}` })
      expect(result.ok).toBe(true)
    }

    const blocked = await submitLead(key.publicKey, { ...VALID, name: 'One too many' })
    expect(blocked).toMatchObject({ ok: false, status: 429, reason: 'rate_limited' })

    const opps = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.companyId, fixture.companyId))
    expect(opps).toHaveLength(3)
  })

  it('counts only accepted submissions toward the limit', async () => {
    const { key } = await keyFixture({ hourlyLimit: 2 })

    // Junk must not lock a real visitor out of the form.
    for (let i = 0; i < 5; i++) {
      await submitLead(key.publicKey, { name: '' })
    }

    const result = await submitLead(key.publicKey, VALID)
    expect(result.ok).toBe(true)
  })

  it('stops writing rejection rows past a ceiling', async () => {
    const { fixture, key } = await keyFixture({ hourlyLimit: 1 })

    // The ceiling is ten times the hourly allowance.
    for (let i = 0; i < 25; i++) {
      await submitLead(key.publicKey, { name: '' })
    }

    const [row] = await db
      .select({ total: sql<string>`count(*)` })
      .from(leadSubmissions)
      .where(eq(leadSubmissions.companyId, fixture.companyId))

    // The log cannot be used to exhaust storage.
    expect(Number(row.total)).toBeLessThanOrEqual(11)
  })

  it('does not let an old submission window block a new one', async () => {
    const { fixture, key } = await keyFixture({ hourlyLimit: 1 })
    await submitLead(key.publicKey, VALID)

    // Age the accepted submission out of the window.
    await db
      .update(leadSubmissions)
      .set({ receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(leadSubmissions.companyId, fixture.companyId))

    const result = await submitLead(key.publicKey, { ...VALID, name: 'Later visitor' })
    expect(result.ok).toBe(true)
  })
})

describe('intake keys are tenant scoped', () => {
  it('writes the lead to the key\'s company and no other', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })
    const alphaKey = await createIntakeKey(alpha.ctx, { name: 'Alpha form' })

    await submitLead(alphaKey.publicKey, VALID)

    const alphaOpps = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.companyId, alpha.companyId))
    const betaOpps = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.companyId, beta.companyId))

    expect(alphaOpps).toHaveLength(1)
    expect(betaOpps).toHaveLength(0)
  })

  it('does not list another company\'s keys', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })
    await createIntakeKey(alpha.ctx, { name: 'Alpha form' })

    expect(await listIntakeKeys(alpha.ctx)).toHaveLength(1)
    expect(await listIntakeKeys(beta.ctx)).toHaveLength(0)
  })

  it('will not revoke a key belonging to another company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })
    const alphaKey = await createIntakeKey(alpha.ctx, { name: 'Alpha form' })

    await revokeIntakeKey(beta.ctx, alphaKey.id)

    const [unchanged] = await db
      .select()
      .from(leadIntakeKeys)
      .where(eq(leadIntakeKeys.id, alphaKey.id))
    expect(unchanged.isActive).toBe(true)
  })

  it('requires crm:manage to create a key', async () => {
    const fixture = await createCompanyFixture()
    const marketing = await addUserWithRole(fixture, 'marketing')

    await expect(createIntakeKey(marketing, { name: 'Nope' })).rejects.toThrow(PermissionError)
  })

  it('issues unguessable keys', async () => {
    const fixture = await createCompanyFixture()
    const first = await createIntakeKey(fixture.ctx, { name: 'A' })
    const second = await createIntakeKey(fixture.ctx, { name: 'B' })

    expect(first.publicKey).not.toBe(second.publicKey)
    expect(first.publicKey.startsWith('pk_')).toBe(true)
    expect(first.publicKey.length).toBeGreaterThan(20)
  })

  it('tracks usage on the key', async () => {
    const { fixture, key } = await keyFixture()
    await submitLead(key.publicKey, VALID)

    const [updated] = await db
      .select()
      .from(leadIntakeKeys)
      .where(and(eq(leadIntakeKeys.id, key.id), eq(leadIntakeKeys.companyId, fixture.companyId)))

    expect(updated.submissionCount).toBe(1)
    expect(updated.lastUsedAt).not.toBeNull()
  })
})
