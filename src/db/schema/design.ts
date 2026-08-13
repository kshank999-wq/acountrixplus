import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  unique,
  pgEnum,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'
import { brandKits } from './studio'
import { proposals, proposalVersions } from './crm'

/**
 * The shared design engine (spec §7, §8).
 *
 * Spec §8 requires the same engine serve proposals *and* marketing collateral,
 * so nothing in this schema knows what a proposal is. A document is a page
 * setup, a brand kit, and an ordered list of blocks; what it is *for* is a
 * `kind` and an optional owner reference.
 *
 * Spec §7 also sets the scope: "The first release should prioritize
 * business-document layout features; advanced Illustrator-class path editing
 * can be phased in after the core proposal workflow is stable." So the model
 * is a flowing block document, not a free vector canvas — see ADR 0004.
 */

export const documentKindEnum = pgEnum('document_kind', [
  'proposal',
  'marketing',
  'template',
])

export const pageSizeEnum = pgEnum('page_size', ['letter', 'a4', 'legal'])

/**
 * A design document — the unit the renderer draws and the editor edits.
 *
 * `blocks` is JSONB rather than a table because a document is always read and
 * written whole, and because that makes an immutable snapshot on send a single
 * value copy rather than a fan-out of rows.
 */
export const designDocuments = pgTable(
  'design_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    kind: documentKindEnum('kind').notNull().default('proposal'),
    name: text('name').notNull(),

    /** What this document belongs to, when it belongs to something. */
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'cascade' }),

    brandKitId: uuid('brand_kit_id').references(() => brandKits.id, { onDelete: 'set null' }),

    pageSize: pageSizeEnum('page_size').notNull().default('letter'),
    orientation: text('orientation', { enum: ['portrait', 'landscape'] })
      .notNull()
      .default('portrait'),
    /** Page margins in points, so print output is exact. */
    marginTopPt: integer('margin_top_pt').notNull().default(54),
    marginRightPt: integer('margin_right_pt').notNull().default(54),
    marginBottomPt: integer('margin_bottom_pt').notNull().default(54),
    marginLeftPt: integer('margin_left_pt').notNull().default(54),

    /** Repeating page furniture (spec §7 headers/footers, page numbering). */
    headerText: text('header_text'),
    footerText: text('footer_text'),
    showPageNumbers: boolean('show_page_numbers').notNull().default(true),

    /** The ordered block list. Shape is validated in `modules/design/blocks`. */
    blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyKindIdx: index('design_documents_company_kind_idx').on(t.companyId, t.kind),
    proposalIdx: index('design_documents_proposal_idx').on(t.proposalId),
  }),
)

/**
 * A reusable document template (spec §7 template gallery).
 *
 * `companyId` is null for the built-in gallery shipped with the product, and
 * set for a company's own saved templates. `industry` lets the gallery be
 * filtered to what a business actually does, matching the industry packs the
 * chart of accounts already uses.
 */
export const documentTemplates = pgTable(
  'document_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null means a built-in template available to every company. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),

    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: documentKindEnum('kind').notNull().default('proposal'),
    /** Matches the industry keys used by the chart-of-accounts packs. */
    industry: text('industry'),

    blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Built-in keys are globally unique; a company may shadow one with its own.
    companyKeyUnique: unique('document_templates_company_key_unique').on(t.companyId, t.key),
    galleryIdx: index('document_templates_gallery_idx').on(t.kind, t.industry),
  }),
)

/**
 * A client's acceptance of a proposal (spec §7).
 *
 * Records exactly what was agreed to: which immutable version, which optional
 * items the client selected, the total at that moment, and the signature. All
 * captured through a public endpoint, so the request metadata is kept for
 * evidentiary value — truncated the same way lead intake truncates it.
 */
export const proposalAcceptances = pgTable(
  'proposal_acceptances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    /** The exact version the client was looking at when they accepted. */
    proposalVersionId: uuid('proposal_version_id'),

    signerName: text('signer_name').notNull(),
    signerEmail: text('signer_email'),
    signerTitle: text('signer_title'),
    /** Typed signature. A drawn one would be an asset reference instead. */
    signatureText: text('signature_text').notNull(),

    /** Optional items the client chose, and what that made the total. */
    selectedItemIds: jsonb('selected_item_ids').$type<string[]>().notNull().default([]),
    acceptedTotalCents: integer('accepted_total_cents').notNull(),

    ipPrefix: text('ip_prefix'),
    userAgent: text('user_agent'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One acceptance per proposal: a signed document is signed once.
    proposalUnique: unique('proposal_acceptances_proposal_unique').on(t.proposalId),
    companyIdx: index('proposal_acceptances_company_idx').on(t.companyId, t.acceptedAt),
    // Named explicitly: the generated name would exceed Postgres's 63-byte limit.
    versionFk: foreignKey({
      name: 'proposal_acceptances_version_fk',
      columns: [t.proposalVersionId],
      foreignColumns: [proposalVersions.id],
    }).onDelete('set null'),
  }),
)
