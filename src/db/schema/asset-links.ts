import { pgTable, uuid, text, timestamp, index, check, foreignKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { assets } from './studio'
import { campaigns } from './marketing'
import { contacts, opportunities, organizations } from './crm'
import { customers } from './receivables'

/**
 * What a creative asset is about (Phase 180, spec §8).
 *
 * §8's last bullet — *"Assets can be associated with campaigns, contacts,
 * companies, opportunities, or client records"* — had nothing behind it, so the
 * question a studio exists to answer before making the next thing could not be
 * asked: **what have we sent this client.**
 *
 * ## Its own file, and why
 *
 * `crm.ts` already imports `studio.ts`, so this cannot live in either: a table
 * referencing both sides of an existing dependency has to sit downstream of
 * them. A leaf file is the shape that has no opinion about which of the five
 * subjects matters most, which is also true of the capability.
 *
 * ## Five columns rather than a `subject_type` enum
 *
 * `document_links` is the precedent and this deliberately departs from it.
 * That table's own docstring says why:
 *
 * > A polymorphic reference has no foreign key, so nothing in the database
 * > stops a link pointing at a uuid that belongs to another company — or to
 * > nothing at all. The check has to live in code.
 *
 * Right in Phase 20, wrong now: Phases 170–172 spent three phases putting the
 * tenant into keys so the database would refuse what a forgotten check lets
 * through, and Phase 179 found a cross-tenant check that had been broken for
 * nine phases. So every subject here is a **real composite foreign key**
 * carrying the tenant, and a CHECK requires exactly one of the five.
 *
 * The price, stated rather than discovered: a sixth kind of subject is a
 * migration. §8 names five.
 */
export const assetLinks = pgTable(
  'asset_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    assetId: uuid('asset_id').notNull(),

    /*
      Exactly one of the five, enforced by `asset_links_one_subject_check`.
      `modules/studio/asset-subjects.ts` is the only place that turns a subject
      kind into one of these columns, so a row with two is unreachable rather
      than merely refused.
    */
    campaignId: uuid('campaign_id'),
    contactId: uuid('contact_id'),
    organizationId: uuid('organization_id'),
    opportunityId: uuid('opportunity_id'),
    customerId: uuid('customer_id'),

    /**
     * Why this asset is on this record.
     *
     * Optional on purpose: *"the capability statement we sent them in March"*
     * is worth writing down and *"logo.png on our own company record"* is not,
     * and a required note would be filled in with the filename.
     */
    note: text('note'),

    linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    assetFk: foreignKey({
      name: 'asset_links_asset_fkey',
      columns: [t.companyId, t.assetId],
      foreignColumns: [assets.companyId, assets.id],
    }).onDelete('cascade'),
    campaignFk: foreignKey({
      name: 'asset_links_campaign_fkey',
      columns: [t.companyId, t.campaignId],
      foreignColumns: [campaigns.companyId, campaigns.id],
    }).onDelete('cascade'),
    contactFk: foreignKey({
      name: 'asset_links_contact_fkey',
      columns: [t.companyId, t.contactId],
      foreignColumns: [contacts.companyId, contacts.id],
    }).onDelete('cascade'),
    organizationFk: foreignKey({
      name: 'asset_links_organization_fkey',
      columns: [t.companyId, t.organizationId],
      foreignColumns: [organizations.companyId, organizations.id],
    }).onDelete('cascade'),
    opportunityFk: foreignKey({
      name: 'asset_links_opportunity_fkey',
      columns: [t.companyId, t.opportunityId],
      foreignColumns: [opportunities.companyId, opportunities.id],
    }).onDelete('cascade'),
    customerFk: foreignKey({
      name: 'asset_links_customer_fkey',
      columns: [t.companyId, t.customerId],
      foreignColumns: [customers.companyId, customers.id],
    }).onDelete('cascade'),

    /*
      Counted rather than written as five `is null` chains, because the chain is
      ten comparisons that have to stay in step and the count is one number.

      Exactly one, not "at least one" — which would let a row name a campaign
      *and* a contact and leave every reader guessing which association it is —
      and not "at most one", which would let a link point at nothing.
    */
    oneSubject: check(
      'asset_links_one_subject_check',
      sql`(${t.campaignId} is not null)::int
          + (${t.contactId} is not null)::int
          + (${t.organizationId} is not null)::int
          + (${t.opportunityId} is not null)::int
          + (${t.customerId} is not null)::int
          = 1`,
    ),

    assetIdx: index('asset_links_asset_idx').on(t.companyId, t.assetId),
  }),
)
