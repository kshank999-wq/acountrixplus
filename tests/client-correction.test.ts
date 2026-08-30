import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import {
  createOrganization,
  organizationById,
  updateOrganization,
} from '@/modules/crm/opportunities'
import {
  ORGANIZATION_FIELDS,
  describeChanges,
  diffParty,
  normaliseParty,
} from '@/modules/parties/changes'
import { permissionToRead, withheldEntityTypes } from '@/modules/audit/visibility'
import { historyFor } from '@/modules/audit'
import { can } from '@/modules/tenancy/context'

/**
 * Correcting a client (Phase 78).
 *
 * Phase 45 built the whole vocabulary for changing a party record and gave it
 * to `customers` and `vendors`. The CRM's own record of who the client is never
 * got an update path at all — no service, no action, no form.
 */

const FULL = {
  name: 'Summit Property Group',
  email: 'hello@summit.test',
  phone: '555 0100',
  website: 'summit.test',
  addressLine1: 'Unit 4',
  addressLine2: 'Kiln Yard',
  city: 'Bellingham',
  region: 'WA',
  postalCode: '98226',
  country: 'United States',
  industry: 'Property',
  source: 'referral',
}

describe('the fields an organisation has always had columns for', () => {
  /**
   * `organizations` has had all six address columns since Phase 3 and
   * `createOrganization` took two of them, so a client's street and postcode
   * could not be entered at all — and Phase 77 freezes that address into every
   * agreement they sign.
   */
  it('accepts the whole address on the way in', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)

    expect(organization.addressLine1).toBe('Unit 4')
    expect(organization.addressLine2).toBe('Kiln Yard')
    expect(organization.city).toBe('Bellingham')
    expect(organization.region).toBe('WA')
    expect(organization.postalCode).toBe('98226')
    expect(organization.country).toBe('United States')
  })

  it('names every one of them on the change registry', () => {
    const keys = ORGANIZATION_FIELDS.map((field) => field.key)

    for (const key of ['addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country']) {
      expect(keys).toContain(key)
    }
  })
})

describe('correcting a client', () => {
  it('changes what was asked for and leaves the rest alone', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)

    const updated = await updateOrganization(fixture.ctx, organization.id, {
      name: 'Summit Holdings Ltd',
      postalCode: '98227',
    })

    expect(updated.name).toBe('Summit Holdings Ltd')
    expect(updated.postalCode).toBe('98227')

    // A form showing six of thirteen fields must not blank the other seven.
    expect(updated.addressLine1).toBe('Unit 4')
    expect(updated.industry).toBe('Property')
    expect(updated.email).toBe('hello@summit.test')
  })

  /**
   * `'organization.update'` has been in the audit action union since Phase 3
   * and nothing had ever written it.
   */
  it('records what changed, and only what changed', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)

    await updateOrganization(fixture.ctx, organization.id, { city: 'Seattle' })

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.companyId, fixture.companyId),
          eq(auditEvents.action, 'organization.update'),
        ),
      )

    expect(event).toBeDefined()
    expect(event.entityType).toBe('organization')
    expect(event.entityId).toBe(organization.id)
    expect(event.before).toEqual({ city: 'Bellingham' })
    expect(event.after).toEqual({ city: 'Seattle' })
  })

  /** An untouched form saved is not a change — `updateCustomer`'s rule. */
  it('writes nothing when a form is saved without an edit', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)

    await updateOrganization(fixture.ctx, organization.id, {
      name: FULL.name,
      city: FULL.city,
    })

    const events = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.companyId, fixture.companyId),
          eq(auditEvents.action, 'organization.update'),
        ),
      )

    expect(events).toHaveLength(0)
  })

  it('refuses to leave a client without a name', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)

    await expect(
      updateOrganization(fixture.ctx, organization.id, { name: '   ' }),
    ).rejects.toThrow(/needs a name/i)
  })

  it('will not reach another company’s client', async () => {
    const ours = await createCompanyFixture({ name: 'Ours' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })
    const organization = await createOrganization(theirs.ctx, FULL)

    await expect(
      updateOrganization(ours.ctx, organization.id, { name: 'Taken' }),
    ).rejects.toThrow(/not on these books/i)
  })

  it('empties a field rather than storing a blank string', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)

    const updated = await updateOrganization(fixture.ctx, organization.id, {
      ...normaliseParty({ addressLine2: '' }),
    })

    expect(updated.addressLine2).toBeNull()
  })

  it('says which fields changed rather than counting them', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)

    const before = await organizationById(fixture.ctx, organization.id)
    const changes = diffParty({
      fields: ORGANIZATION_FIELDS,
      before,
      after: { city: 'Seattle', postalCode: '98104' },
    })

    expect(describeChanges(changes)).toBe('City and postcode updated.')
  })
})

/**
 * Found while giving `organization.update` a writer: six CRM entity types have
 * written audit events since Phase 3 and none of them were ever placed, so
 * every one fell through to `audit:view` — which `sales` does not hold.
 */
describe('the CRM can read its own history', () => {
  it('opens a client’s history to whoever may read the client', () => {
    for (const entityType of [
      'organization',
      'opportunity',
      'proposal',
      'design_document',
      'document_template',
      'lead_intake_key',
    ]) {
      expect(permissionToRead(entityType)).toBe('crm:view')
    }
  })

  it('withholds them from a reader who holds no crm:view', () => {
    const withheld = withheldEntityTypes((permission) => permission !== 'crm:view')
    expect(withheld).toContain('organization')
    expect(withheld).toContain('proposal')
  })

  it('lets a salesperson read the correction they just made', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const organization = await createOrganization(fixture.ctx, FULL)
    await updateOrganization(fixture.ctx, organization.id, { city: 'Seattle' })

    const sales = { ...fixture.ctx, role: 'sales' as const }

    // The premise: sales holds `crm:view` and does not hold `audit:view`.
    expect(can(sales, 'crm:view')).toBe(true)
    expect(can(sales, 'audit:view')).toBe(false)

    const history = await historyFor(sales, 'organization', organization.id)
    expect(history.map((row) => row.action)).toContain('organization.update')
  })
})
