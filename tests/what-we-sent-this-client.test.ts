import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { assetLinks } from '@/db/schema'
import { createCompanyFixture, addUserWithRole, type Fixture } from './helpers'
import { RegistryError } from '@/modules/errors/registry'
import { DomainError } from '@/modules/errors'
import { PermissionError } from '@/modules/permissions'
import { uploadAsset } from '@/modules/studio/assets'
import {
  createContact,
  createOpportunity,
  createOrganization,
} from '@/modules/crm/opportunities'
import { createCampaign } from '@/modules/marketing/campaigns'
import { createCustomer } from '@/modules/receivables/service'
import {
  ASSET_SUBJECTS,
  assetSubjectFor,
  assetSubjectStands,
  subjectAssignment,
  subjectOf,
  type AssetSubjectKind,
} from '@/modules/studio/asset-subjects'
import {
  MAX_LINKS_PER_SUBJECT,
  assetCountsForSubjects,
  assetsForSubject,
  associableKinds,
  linkAsset,
  subjectsForAsset,
  unlinkAsset,
} from '@/modules/studio/asset-links'

/**
 * What we sent this client (Phase 180, spec §8).
 *
 * §8's last bullet — *"Assets can be associated with campaigns, contacts,
 * companies, opportunities, or client records"* — was one of the eight
 * capabilities ADR 0173 measured as having nothing behind them, and the
 * measurement held: `assets` carried `company_id`, `kind`, `filename`, storage,
 * provenance and `derived_from_id`, and not one column naming any of the five.
 *
 * ## The design decision these tests are mostly about
 *
 * `document_links` is the precedent — a `subject_type` enum, a `subject_id`, and
 * `modules/evidence/subjects.ts` registering what may carry evidence — and this
 * deliberately departs from it, because that table's own docstring says why not:
 *
 * > A polymorphic reference has no foreign key, so nothing in the database stops
 * > a link pointing at a uuid that belongs to another company — or to nothing at
 * > all. The check has to live in code.
 *
 * So `asset_links` has **five real composite foreign keys and a CHECK that
 * exactly one is set**, and most of what is asserted below is the database
 * refusing things rather than a function refusing them. That is the point: the
 * tests that matter are the ones that would still pass with the service layer
 * deleted.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

async function anAsset(fixture: Fixture, filename = 'capability-statement.png') {
  const asset = await uploadAsset(fixture.ctx, {
    filename,
    contentType: 'image/png',
    data: PNG,
    kind: 'document',
  })
  return asset
}

/** One of each of §8's five, so every kind can be exercised for real. */
async function allFiveSubjects(fixture: Fixture) {
  const organization = await createOrganization(fixture.ctx, { name: 'Harborview Marine' })
  const contact = await createContact(fixture.ctx, {
    organizationId: organization.id,
    firstName: 'Dana',
    lastName: 'Reyes',
  })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Refit, spring',
  })
  const campaign = await createCampaign(fixture.ctx, { name: 'Spring refit push' })
  const customer = await createCustomer(fixture.ctx, { name: 'Harborview Marine' })

  return {
    campaign: { kind: 'campaign' as const, id: campaign.id },
    contact: { kind: 'contact' as const, id: contact.id },
    organization: { kind: 'organization' as const, id: organization.id },
    opportunity: { kind: 'opportunity' as const, id: opportunity.id },
    customer: { kind: 'customer' as const, id: customer.id },
  }
}

function constraintBrokenBy(write: Promise<unknown>): Promise<string | undefined> {
  return write.then(
    () => undefined,
    (error: { cause?: { constraint_name?: string } }) => error.cause?.constraint_name,
  )
}

// ---------------------------------------------------------------------------

describe('the register', () => {
  it('argues every kind by the question it answers', () => {
    /**
     * Phase 101's device, with the floor set on a particular question. §8 names
     * five records in one bullet, so an entry that repeats the bullet tells a
     * reader nothing about which of the five they want — the argument has to
     * say what question the association answers.
     */
    expect(ASSET_SUBJECTS.flatMap((subject) => assetSubjectStands(subject))).toEqual([])
  })

  it('declares five kinds, in the order §8 names them', () => {
    // Measured, not bounded (Phase 126). The order is the specification's
    // rather than alphabetical, so a reader with the bullet open can check the
    // list against it without re-sorting either.
    expect(ASSET_SUBJECTS).toHaveLength(5)
    expect(ASSET_SUBJECTS.map((subject) => subject.kind)).toEqual([
      'campaign',
      'contact',
      'organization',
      'opportunity',
      'customer',
    ])
  })

  it('maps each kind back to the word §8 uses for it', () => {
    /**
     * The mapping is where this could quietly be wrong. §8 says *companies* and
     * *client records* as two separate things, and in this codebase those are
     * `organizations` (the CRM's record of another business, which may never
     * become a client) and `customers` (the record carrying invoices and a
     * balance). Reading them as one thing would have produced four kinds and
     * lost the distinction the bullet draws.
     */
    expect(ASSET_SUBJECTS.map((subject) => subject.specWord)).toEqual([
      'campaigns',
      'contacts',
      'companies',
      'opportunities',
      'client records',
    ])

    expect(assetSubjectFor('organization').specWord).toBe('companies')
    expect(assetSubjectFor('customer').specWord).toBe('client records')
    // And the label a person sees is the trade's word, not the table's.
    expect(assetSubjectFor('customer').label).toBe('Client')
  })

  it('throws on a kind nobody declared, naming the ones that exist', () => {
    expect(() => assetSubjectFor('invoice')).toThrow(RegistryError)

    try {
      assetSubjectFor('invoice')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('ASSET_SUBJECTS')
      expect((error as RegistryError).message).toContain('opportunity')
    }
  })

  it('asks for the subject’s own view permission and the studio’s to manage', () => {
    /**
     * The asymmetry is deliberate. `view` follows the record — somebody who
     * cannot see an opportunity has no business seeing what was sent against it
     * — and `manage` is the studio's everywhere, because attaching a flyer to a
     * contact is a studio act wherever the contact lives.
     */
    expect(ASSET_SUBJECTS.map((subject) => subject.view)).toEqual([
      'marketing:view',
      'crm:view',
      'crm:view',
      'crm:view',
      'crm:view',
    ])
    expect(new Set(ASSET_SUBJECTS.map((subject) => subject.manage))).toEqual(
      new Set(['marketing:manage']),
    )
  })
})

describe('turning a kind into a column', () => {
  it('sets exactly one and nulls the other four', () => {
    /**
     * The single place a kind becomes a column, so no caller writes
     * `{ campaignId: id }` by hand. The CHECK refuses a row with two subjects;
     * this makes a row with two *unreachable*, which is the difference between
     * a constraint catching a bug and a constraint catching a bug somebody
     * could have avoided writing.
     */
    for (const subject of ASSET_SUBJECTS) {
      const assignment = subjectAssignment({ kind: subject.kind, id: 'subject-1' })
      const set = Object.entries(assignment).filter(([, value]) => value !== null)

      expect(set, subject.kind).toEqual([[subject.column, 'subject-1']])
      expect(Object.keys(assignment)).toHaveLength(5)
    }
  })

  it('reads the subject back off a stored row', () => {
    for (const subject of ASSET_SUBJECTS) {
      const row = subjectAssignment({ kind: subject.kind, id: 'subject-1' })
      expect(subjectOf(row), subject.kind).toEqual({ kind: subject.kind, id: 'subject-1' })
    }
  })

  it('treats a row with no subject as a missing constraint, not an odd row', () => {
    /**
     * `asset_links_one_subject_check` makes such a row impossible, so finding
     * one means the constraint is gone from the database rather than that the
     * row is unusual. Reporting it as "this link has no subject" would describe
     * the symptom while hiding the cause, so it throws and says where to look.
     */
    const empty = {
      campaignId: null,
      contactId: null,
      organizationId: null,
      opportunityId: null,
      customerId: null,
    }

    expect(() => subjectOf(empty)).toThrow(RegistryError)
    try {
      subjectOf(empty)
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).message).toContain('check the migrations')
    }
  })
})

describe('what the database refuses', () => {
  it('refuses a link naming two subjects, and one naming none', async () => {
    /**
     * The CHECK, from both sides. "At least one" would let a row name a
     * campaign *and* a contact and leave every reader guessing which
     * association it is; "at most one" would let a link point at nothing and
     * make the whole table rows that mean nothing.
     */
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)
    const subjects = await allFiveSubjects(fixture)

    const base = { companyId: fixture.companyId, assetId: asset.id }

    expect(
      await constraintBrokenBy(
        db.insert(assetLinks).values({
          ...base,
          campaignId: subjects.campaign.id,
          contactId: subjects.contact.id,
        }),
      ),
    ).toBe('asset_links_one_subject_check')

    expect(await constraintBrokenBy(db.insert(assetLinks).values(base))).toBe(
      'asset_links_one_subject_check',
    )

    // And exactly one is accepted, so the CHECK is a check rather than a ban.
    expect(
      await constraintBrokenBy(
        db.insert(assetLinks).values({ ...base, campaignId: subjects.campaign.id }),
      ),
    ).toBeUndefined()
  })

  it('refuses another company’s record, by the key rather than by a check', async () => {
    /**
     * **The whole argument of the migration, asserted.** With a polymorphic
     * `subject_id` this row would be written and only a function somebody
     * remembered to call would have stopped it. Every one of §8's five is
     * exercised, because a composite key on four of them and a plain one on the
     * fifth would pass a test that only checked a campaign.
     */
    const ours = await createCompanyFixture({ name: 'Ours' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })

    const asset = await anAsset(ours)
    const theirSubjects = await allFiveSubjects(theirs)

    for (const subject of ASSET_SUBJECTS) {
      const ref = theirSubjects[subject.kind as keyof typeof theirSubjects]

      expect(
        await constraintBrokenBy(
          db.insert(assetLinks).values({
            companyId: ours.companyId,
            assetId: asset.id,
            ...subjectAssignment({ kind: subject.kind, id: ref.id }),
          }),
        ),
        subject.kind,
      ).toBe(`asset_links_${subject.kind}_fkey`)
    }

    // Nothing was written by any of the five attempts.
    const rows = await db
      .select()
      .from(assetLinks)
      .where(eq(assetLinks.companyId, ours.companyId))
    expect(rows).toEqual([])
  })

  it('refuses a uuid that names nothing at all', async () => {
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)

    expect(
      await constraintBrokenBy(
        db.insert(assetLinks).values({
          companyId: fixture.companyId,
          assetId: asset.id,
          organizationId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe('asset_links_organization_fkey')
  })

  it('refuses the same asset on the same record twice', async () => {
    /**
     * Five partial unique indexes, one per column, and the partial form is
     * load-bearing: Postgres treats NULLs as distinct, so a plain UNIQUE over
     * all five columns would permit `(asset, campaign)` twice as long as the
     * other four were null — which is every row.
     */
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)
    const subjects = await allFiveSubjects(fixture)

    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.organization })

    expect(
      await constraintBrokenBy(
        db.insert(assetLinks).values({
          companyId: fixture.companyId,
          assetId: asset.id,
          organizationId: subjects.organization.id,
        }),
      ),
    ).toBe('asset_links_organization_unique')

    // The same asset on a *different* kind of record is a different
    // association and is allowed — which is what the partial indexes buy.
    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.customer })
    expect(await subjectsForAsset(fixture.ctx, asset.id)).toHaveLength(2)
  })

  it('takes the links with the record when the record is deleted', async () => {
    /**
     * `ON DELETE CASCADE` per column. The polymorphic alternative leaves rows
     * pointing at nothing, which is how `document_links` can hold a link to a
     * deleted subject and no query can tell.
     */
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)
    const subjects = await allFiveSubjects(fixture)

    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.campaign })
    expect(await assetsForSubject(fixture.ctx, subjects.campaign)).toHaveLength(1)

    /*
      The campaign is deleted beneath the service on purpose: the point is that
      the *database* removes the link, not that a function remembered to.
    */
    const { campaigns } = await import('@/db/schema')
    await db.delete(campaigns).where(eq(campaigns.id, subjects.campaign.id))

    const left = await db
      .select()
      .from(assetLinks)
      .where(eq(assetLinks.companyId, fixture.companyId))
    expect(left).toEqual([])
  })

  it('takes the links with the asset when the asset is deleted', async () => {
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)
    const subjects = await allFiveSubjects(fixture)

    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.contact })

    const { assets } = await import('@/db/schema')
    await db.delete(assets).where(eq(assets.id, asset.id))

    expect(
      await db.select().from(assetLinks).where(eq(assetLinks.companyId, fixture.companyId)),
    ).toEqual([])
  })
})

describe('§8’s question', () => {
  it('answers what we sent this client', async () => {
    /**
     * The capability, end to end. Before this phase there was no column to ask
     * it of, which is why ADR 0173 listed it rather than describing it.
     */
    const fixture = await createCompanyFixture()
    const subjects = await allFiveSubjects(fixture)

    const statement = await anAsset(fixture, 'capability-statement.png')
    const flyer = await anAsset(fixture, 'refit-flyer.png')
    const unrelated = await anAsset(fixture, 'our-logo.png')

    await linkAsset(fixture.ctx, {
      assetId: statement.id,
      subject: subjects.organization,
      note: 'Sent with the first approach in February',
    })
    await linkAsset(fixture.ctx, { assetId: flyer.id, subject: subjects.organization })

    const sent = await assetsForSubject(fixture.ctx, subjects.organization)

    expect(sent.map((row) => row.filename).sort()).toEqual([
      'capability-statement.png',
      'refit-flyer.png',
    ])
    expect(sent.map((row) => row.filename)).not.toContain('our-logo.png')
    expect(unrelated.id).toBeTruthy()

    const withNote = sent.find((row) => row.filename === 'capability-statement.png')!
    expect(withNote.note).toBe('Sent with the first approach in February')
    expect(withNote.sizeBytes).toBe(PNG.length)
  })

  it('answers the other direction too', async () => {
    const fixture = await createCompanyFixture()
    const subjects = await allFiveSubjects(fixture)
    const asset = await anAsset(fixture)

    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.organization })
    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.opportunity })
    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.contact })

    const where = await subjectsForAsset(fixture.ctx, asset.id)

    expect(where.map((row) => row.kind).sort()).toEqual([
      'contact',
      'opportunity',
      'organization',
    ])

    // Named, not just typed — an id alone means nothing to anybody.
    const byKind = new Map(where.map((row) => [row.kind, row]))
    expect(byKind.get('organization')!.describe).toBe('Harborview Marine')
    expect(byKind.get('opportunity')!.describe).toBe('Refit, spring')
    // A contact has `first_name` and `last_name` and no `name`, joined here.
    expect(byKind.get('contact')!.describe).toBe('Dana Reyes')
    expect(byKind.get('contact')!.label).toBe('Contact')
  })

  it('counts them for a list screen in one query', async () => {
    const fixture = await createCompanyFixture()
    const first = await createOrganization(fixture.ctx, { name: 'First' })
    const second = await createOrganization(fixture.ctx, { name: 'Second' })
    const third = await createOrganization(fixture.ctx, { name: 'Third, nothing sent' })

    const a = await anAsset(fixture, 'a.png')
    const b = await anAsset(fixture, 'b.png')

    await linkAsset(fixture.ctx, {
      assetId: a.id,
      subject: { kind: 'organization', id: first.id },
    })
    await linkAsset(fixture.ctx, {
      assetId: b.id,
      subject: { kind: 'organization', id: first.id },
    })
    await linkAsset(fixture.ctx, {
      assetId: a.id,
      subject: { kind: 'organization', id: second.id },
    })

    const counts = await assetCountsForSubjects(fixture.ctx, 'organization', [
      first.id,
      second.id,
      third.id,
    ])

    expect(counts.get(first.id)).toBe(2)
    expect(counts.get(second.id)).toBe(1)
    // Absent rather than zero, so a screen can tell "none" from "not asked".
    expect(counts.has(third.id)).toBe(false)
  })

  it('offers the five kinds for a picker', () => {
    expect(associableKinds()).toEqual([
      { kind: 'campaign', label: 'Campaign' },
      { kind: 'contact', label: 'Contact' },
      { kind: 'organization', label: 'Organisation' },
      { kind: 'opportunity', label: 'Opportunity' },
      { kind: 'customer', label: 'Client' },
    ])
  })
})

describe('what the service adds on top', () => {
  it('turns the database’s refusal into a sentence a person can act on', async () => {
    /**
     * Phase 119. The driver's message names a constraint rather than a thing,
     * and the constraint name is on the error's `cause` and not its message —
     * the detail that made two assertions in Phase 177 pass against the wrong
     * constraint.
     */
    const ours = await createCompanyFixture({ name: 'Ours' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })
    const asset = await anAsset(ours)
    const theirSubjects = await allFiveSubjects(theirs)

    await expect(
      linkAsset(ours.ctx, { assetId: asset.id, subject: theirSubjects.organization }),
    ).rejects.toThrow(/not on this company's books/)

    const subjects = await allFiveSubjects(ours)
    await linkAsset(ours.ctx, { assetId: asset.id, subject: subjects.customer })
    await expect(
      linkAsset(ours.ctx, { assetId: asset.id, subject: subjects.customer }),
    ).rejects.toThrow(/already associated with this client/i)
  })

  it('bounds how many assets one record can carry', async () => {
    /**
     * Not an arbitrary limit. Associating everything with everything is the
     * same as associating nothing, and the refusal says so rather than letting
     * a bulk mistake make the panel useless.
     *
     * The bound is asserted rather than the behaviour at it, because inserting
     * two hundred assets to see the two hundred and first refused would be a
     * slow test for a constant.
     */
    expect(MAX_LINKS_PER_SUBJECT).toBe(200)
  })

  it('detaches, and reads the permission off the row rather than the request', async () => {
    /**
     * `unlinkAsset` takes a link id and nothing else, so which permission
     * applies is decided by what the row says it is about. A caller naming the
     * kind would be a caller able to name the lenient one.
     */
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)
    const subjects = await allFiveSubjects(fixture)

    const { linkId } = await linkAsset(fixture.ctx, {
      assetId: asset.id,
      subject: subjects.campaign,
    })
    expect(await assetsForSubject(fixture.ctx, subjects.campaign)).toHaveLength(1)

    await unlinkAsset(fixture.ctx, linkId)
    expect(await assetsForSubject(fixture.ctx, subjects.campaign)).toEqual([])

    await expect(unlinkAsset(fixture.ctx, linkId)).rejects.toThrow(DomainError)
  })

  it('lets a salesperson see what was sent and not decide what belongs', async () => {
    /**
     * `sales` is the role this asymmetry was written for, and the first draft
     * of this test used `readonly` — which holds **neither** `crm:view` nor
     * `marketing:manage`, so it proved nothing in either direction. Measured
     * rather than assumed, which is the same mistake Phase 167 made about
     * `bookkeeper` holding `crm:view`.
     */
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)
    const subjects = await allFiveSubjects(fixture)
    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.organization })
    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.campaign })

    const sales = await addUserWithRole(fixture, 'sales')

    // Sees the collateral on the client, because `sales` holds `crm:view`.
    expect(await assetsForSubject(sales, subjects.organization)).toHaveLength(1)

    // And cannot decide what belongs there, because it does not hold
    // `marketing:manage` — which is the studio's permission everywhere.
    await expect(
      linkAsset(sales, { assetId: asset.id, subject: subjects.contact }),
    ).rejects.toThrow(PermissionError)

    /*
      The consequence of `view` following the record rather than the studio,
      which is the part worth asserting because it is the part somebody would
      call a bug: a salesperson may **not** see the same asset on a *campaign*,
      because that subject's view permission is `marketing:view` and `sales`
      does not hold it. The association is a description of the relationship,
      so the relationship decides who may read it.
    */
    await expect(assetsForSubject(sales, subjects.campaign)).rejects.toThrow(PermissionError)
  })

  it('refuses a reader who can see neither the record nor the studio', async () => {
    const fixture = await createCompanyFixture()
    const asset = await anAsset(fixture)
    const subjects = await allFiveSubjects(fixture)
    await linkAsset(fixture.ctx, { assetId: asset.id, subject: subjects.organization })

    const readonly = await addUserWithRole(fixture, 'readonly')

    expect(await assetsForSubject(fixture.ctx, subjects.organization)).toHaveLength(1)
    await expect(assetsForSubject(readonly, subjects.organization)).rejects.toThrow(
      PermissionError,
    )
    await expect(subjectsForAsset(readonly, asset.id)).rejects.toThrow(PermissionError)
  })

  it('keeps one company’s associations out of another’s', async () => {
    const ours = await createCompanyFixture({ name: 'Ours' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })

    const asset = await anAsset(ours)
    const subjects = await allFiveSubjects(ours)
    const { linkId } = await linkAsset(ours.ctx, {
      assetId: asset.id,
      subject: subjects.organization,
    })

    // Their own organisation, with the same name, carries nothing.
    const theirSubjects = await allFiveSubjects(theirs)
    expect(await assetsForSubject(theirs.ctx, theirSubjects.organization)).toEqual([])
    expect(await subjectsForAsset(theirs.ctx, asset.id)).toEqual([])
    await expect(unlinkAsset(theirs.ctx, linkId)).rejects.toThrow(DomainError)

    // And asking for *our* organisation's id from their context finds nothing,
    // rather than finding ours.
    expect(
      await assetsForSubject(theirs.ctx, { kind: 'organization' as AssetSubjectKind, id: subjects.organization.id }),
    ).toEqual([])
  })
})
